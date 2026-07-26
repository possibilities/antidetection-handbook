// A TLS-terminating lab origin that records the raw ClientHello.
//
// This closes the largest measurement gap in the handbook: everything in
// "Network identity and protocol coherence" is asserted and none of it has been
// observed. The plaintext origin in lib.mjs can only see headers; the transport
// layer — cipher suites, extensions, supported groups, ALPN, GREASE — is
// invisible to it, and that is exactly the layer the handbook says headers
// cannot reproduce.
//
// Method: accept on a plain TCP socket, read and parse the first flight
// ourselves, then unshift the bytes and hand the socket to Node's TLS
// implementation so the connection completes normally. Node stdlib only.
//
// Deliberate scope limit: we report raw ClientHello COMPONENTS and a JA3 string
// and hash, because those are unambiguous. JA4's exact canonicalisation has
// enough edge cases (GREASE handling, SNI/ALPN encoding, sorting rules) that a
// hand-rolled version would be a plausible-looking wrong number — worse than
// none. Components are what an implementor actually needs; hashes are derived.

import { createServer as netServer } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// GREASE values (RFC 8701) appear in ciphers, extensions and groups. JA3 keeps
// them; JA4 strips them. Reporting both makes the difference visible.
const isGrease = (v) => (v & 0x0f0f) === 0x0a0a && (v >> 8) === (v & 0xff);

function parseClientHello(buf) {
  try {
    if (buf[0] !== 0x16) return { error: 'not a TLS handshake record' };
    let p = 5; // skip record header
    if (buf[p] !== 0x01) return { error: 'not a ClientHello' };
    p += 4; // handshake type + length
    const legacyVersion = buf.readUInt16BE(p); p += 2;
    p += 32; // random
    const sidLen = buf[p]; p += 1 + sidLen;

    const cipherLen = buf.readUInt16BE(p); p += 2;
    const ciphers = [];
    for (let i = 0; i < cipherLen; i += 2) ciphers.push(buf.readUInt16BE(p + i));
    p += cipherLen;

    const compLen = buf[p]; p += 1 + compLen;

    const extTotal = buf.readUInt16BE(p); p += 2;
    const end = p + extTotal;
    const extensions = [];
    let groups = [], sigAlgs = [], alpn = [], sni = null, versions = [], keyShare = [];

    while (p + 4 <= end) {
      const type = buf.readUInt16BE(p);
      const len = buf.readUInt16BE(p + 2);
      const body = buf.subarray(p + 4, p + 4 + len);
      extensions.push(type);

      if (type === 0x000a) { // supported_groups
        const n = body.readUInt16BE(0);
        for (let i = 0; i < n; i += 2) groups.push(body.readUInt16BE(2 + i));
      } else if (type === 0x000d) { // signature_algorithms
        const n = body.readUInt16BE(0);
        for (let i = 0; i < n; i += 2) sigAlgs.push(body.readUInt16BE(2 + i));
      } else if (type === 0x0010) { // ALPN
        let q = 2;
        while (q < body.length) { const l = body[q]; alpn.push(body.subarray(q + 1, q + 1 + l).toString()); q += 1 + l; }
      } else if (type === 0x0000) { // SNI
        sni = body.subarray(5).toString();
      } else if (type === 0x002b) { // supported_versions
        for (let i = 1; i < body.length; i += 2) versions.push(body.readUInt16BE(i));
      } else if (type === 0x0033) { // key_share
        let q = 2;
        while (q + 4 <= body.length) {
          const g = body.readUInt16BE(q);
          const l = body.readUInt16BE(q + 2);
          keyShare.push({ group: g, bytes: l });
          q += 4 + l;
        }
      }
      p += 4 + len;
    }

    const hex = (n) => '0x' + n.toString(16).padStart(4, '0');
    // JA3: SSLVersion,Ciphers,Extensions,Curves,PointFormats (GREASE retained,
    // order preserved — that is the whole point of the fingerprint).
    const ja3 = [
      legacyVersion,
      ciphers.filter((c) => !isGrease(c)).join('-'),
      extensions.filter((e) => !isGrease(e)).join('-'),
      groups.filter((g) => !isGrease(g)).join('-'),
      '0',
    ].join(',');

    return {
      legacyVersion: hex(legacyVersion),
      supportedVersions: versions.map(hex),
      sni,
      alpn,
      cipherCount: ciphers.length,
      ciphers: ciphers.map(hex),
      extensionCount: extensions.length,
      extensions: extensions.map(hex),
      groups: groups.map(hex),
      sigAlgs: sigAlgs.map(hex),
      keyShare: keyShare.map((k) => ({ group: hex(k.group), bytes: k.bytes })),
      greasePresent: [...ciphers, ...extensions, ...groups].some(isGrease),
      ja3,
      ja3Hash: createHash('md5').update(ja3).digest('hex'),
    };
  } catch (e) {
    return { error: `parse failed: ${e.message}` };
  }
}

function selfSignedCert() {
  // openssl is present on macOS/Linux; generating in a temp dir keeps the repo
  // free of key material.
  const dir = mkdtempSync(join(tmpdir(), 'lab-tls-'));
  const key = join(dir, 'k.pem');
  const crt = join(dir, 'c.pem');
  execFileSync('openssl', [
    'req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '2',
    '-keyout', key, '-out', crt, '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });
  return { key, crt, dir };
}

export async function startTlsOrigin({ alpnProtocols = ['h2', 'http/1.1'] } = {}) {
  const { key, crt } = selfSignedCert();
  const ctx = createSecureContext({
    key: readFileSync(key),
    cert: readFileSync(crt),
  });

  const hellos = [];
  const requests = [];

  const server = netServer((socket) => {
    socket.once('data', (chunk) => {
      hellos.push({ at: Date.now(), raw: chunk.length, ...parseClientHello(chunk) });
      socket.unshift(chunk);
      const tls = new TLSSocket(socket, {
        isServer: true,
        secureContext: ctx,
        ALPNProtocols: alpnProtocols,
      });
      tls.on('error', () => {});
      tls.on('secure', () => {
        const alpn = tls.alpnProtocol;
        // Serve a minimal response over whichever protocol was negotiated. We
        // only need the connection to complete; the transport is the subject.
        let buf = '';
        tls.on('data', (d) => {
          buf += d.toString('latin1');
          if (alpn === 'h2') {
            requests.push({ alpn, note: 'h2 framing not decoded; ALPN is the observable' });
            tls.end();
          } else if (buf.includes('\r\n\r\n')) {
            const [line, ...rest] = buf.split('\r\n');
            requests.push({ alpn, line, headers: rest.filter(Boolean) });
            tls.end(
              'HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 22\r\nconnection: close\r\n\r\n<!doctype html>ok<br>',
            );
          }
        });
      });
    });
    socket.on('error', () => {});
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    base: `https://127.0.0.1:${port}`,
    hellos,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}
