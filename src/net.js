'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { config } = require('./config');
const { bad } = require('./errors');

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);

function isPrivateIpv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;           // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                          // multicast + reserved
  return false;
}

function isPrivateIpv6(ip) {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true;
  if (s.startsWith('::ffff:')) return isPrivateIpv4(s.slice(7));
  return false;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) return isPrivateIpv6(ip);
  return true;
}

/**
 * Rejects anything that would let a caller use our renderer to reach a private
 * network (SSRF). Resolves DNS so that `evil.com -> 169.254.169.254` is caught too.
 */
async function assertPublicUrl(raw, field = 'url') {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw bad('invalid_url', `"${field}" is not a valid URL.`, {
      hint: 'Include the scheme, for example https://example.com/report.',
      docs: '/docs#url',
    });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw bad('unsupported_url_scheme', `"${field}" must use http:// or https://, got ${u.protocol}//.`, {
      hint: 'file://, data:// and ftp:// are not allowed. Pass the content in "html" instead.',
      docs: '/docs#url',
    });
  }
  if (config.allowPrivateNetwork) return u;

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host.toLowerCase())) {
    throw bad('private_address_blocked', `"${field}" points at ${host}, which is not reachable from PDFMint.`, {
      hint: 'PDFMint renders on our servers, so the URL has to be reachable from the public internet. Fetch the page in your workflow and pass the result in "html" instead.',
      docs: '/docs#url',
    });
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw bad('private_address_blocked', `"${field}" points at the private address ${host}.`, {
        hint: 'PDFMint renders on our servers and cannot reach private networks. Fetch the page in your workflow and pass the result in "html" instead.',
        docs: '/docs#url',
      });
    }
    return u;
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw bad('dns_failed', `Could not resolve the host "${host}".`, {
      hint: 'Check the spelling of the URL, and that the host is publicly resolvable.',
      docs: '/docs#url',
    });
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw bad('private_address_blocked', `"${field}" resolves to a private address.`, {
      hint: 'PDFMint renders on our servers and cannot reach private networks.',
      docs: '/docs#url',
    });
  }
  return u;
}

module.exports = { assertPublicUrl, isPrivateAddress };
