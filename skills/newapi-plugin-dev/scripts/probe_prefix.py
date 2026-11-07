#!/usr/bin/env python3
"""Probe an upstream gateway's plugin route prefixes without spending quota.

Why this script exists: an upstream New API gateway answers any unmatched path
with its single-page-app fallback, so a wrong plugin prefix returns `200` and an
HTML page rather than a 404. Behind one bad prefix, a plugin reports a generic:

    502 server_error / Task request failed

which is the same error a genuinely broken upstream produces. The discriminator
is the content type and the body shape, never the status code.

Run this BEFORE writing apiRoot() in the plugin, and again whenever a reseller
chain starts failing. Reading a task that does not exist costs nothing.

Usage:
    python probe_prefix.py https://upstream.example --prefix ark --prefix kj-sd
    python probe_prefix.py https://upstream.example --path /api/v3/contents/generations/tasks

    # With a key, a real route answers a JSON auth/not-found error instead of 401.
    python probe_prefix.py https://upstream.example --prefix ark --key sk-...

Options:
    --prefix NAME   a plugin key to test, i.e. NAME is tried as /NAME + --path
    --path PATH     the vendor path appended to each prefix (default below)
    --key KEY       upstream bearer token, optional
    --timeout SEC   per-request timeout, default 20

Exit code 0 means exactly one prefix looked like a real JSON API; 1 otherwise.
The winning prefix is what goes into UPSTREAM_PLUGIN_PREFIX.
"""

import argparse
import json
import ssl
import sys
import urllib.error
import urllib.request

DEFAULT_PATH = "/api/v3/contents/generations/tasks/__probe_nonexistent__"


def build_opener():
    # A local proxy commonly intercepts TLS in development, and a proxy handler
    # routes these probes through it. Both are disabled deliberately.
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context)
    )


def classify(status, content_type, body):
    """Turn one response into (verdict, explanation).

    The vendor's JSON error envelope means the route exists. An HTML document
    means the gateway fell through to its SPA and nothing is routed there.
    """
    lowered = (content_type or "").lower()
    head = body[:200].lstrip().lower()

    if head.startswith(b"<!doctype") or head.startswith(b"<html") or b"<html" in head[:100]:
        return "SPA_FALLBACK", "HTML page: no route at this prefix"
    if "text/html" in lowered:
        return "SPA_FALLBACK", "text/html: no route at this prefix"

    if head.startswith(b"{"):
        try:
            parsed = json.loads(body.decode("utf-8", "replace"))
        except json.JSONDecodeError:
            return "JSON_UNPARSED", "JSON-ish body that did not parse"
        codes = ""
        if isinstance(parsed, dict):
            error = parsed.get("error")
            if isinstance(error, dict):
                codes = " code=" + str(error.get("code") or error.get("Code") or "")
                message = error.get("message") or error.get("Message")
                if message:
                    codes += " message=" + str(message)[:80]
            elif parsed.get("ResponseMetadata"):
                codes = " vendor=ResponseMetadata"
        return "JSON_API", "JSON error envelope: a real route answered" + codes

    if status < 400:
        return "AMBIGUOUS", f"status {status} with a non-JSON, non-HTML body"

    return "JSON_API", f"status {status} without an HTML body: treats as a route"


def probe(opener, url, key, timeout):
    request = urllib.request.Request(url, headers={"User-Agent": "prefix-probe"})
    if key:
        request.add_header("Authorization", "Bearer " + key)
    try:
        response = opener.open(request, timeout=timeout)
        body = response.read(4096)
        return response.status, response.headers.get("Content-Type"), body
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get("Content-Type"), error.read(4096)
    except Exception as error:  # noqa: BLE001 - report, do not crash the probe
        return None, None, str(error).encode()


def main(argv):
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("base")
    parser.add_argument("--prefix", action="append", default=[])
    parser.add_argument("--path", default=DEFAULT_PATH)
    parser.add_argument("--key", default="")
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args(argv[1:])

    base = args.base.rstrip("/")
    path = args.path if args.path.startswith("/") else "/" + args.path

    targets = [(None, base + path)]
    for prefix in args.prefix:
        targets.append((prefix, base + "/" + prefix.strip("/") + path))

    opener = build_opener()
    print(f"base   {base}")
    print(f"path   {path}")
    print(f"key    {'set' if args.key else 'not set'}")
    print()

    winners = []
    for prefix, url in targets:
        status, content_type, body = probe(opener, url, args.key, args.timeout)
        label = f"/{prefix}" if prefix else "(host root)"
        if status is None:
            print(f"{label:>16}  ERROR            {body.decode('utf-8', 'replace')[:120]}")
            continue
        verdict, note = classify(status, content_type, body)
        print(f"{label:>16}  {verdict:<16} {status}  {content_type or '-'}")
        print(f"{'':>16}  {note}")
        if verdict == "JSON_API":
            winners.append(prefix)

    print()
    # The host root is probed for contrast, not as a candidate: a New API gateway
    # serves its own /api routes there, so it answers as a JSON API whether or not
    # any plugin prefix is correct. Counting it as a winner would always produce
    # an ambiguous result, so it is reported and excluded from the decision.
    prefix_winners = [name for name in winners if name]
    if prefix_winners and None in winners:
        print("NOTE the host root also answered as a JSON API. That is the gateway's own")
        print("     /api surface, not a plugin route, so it is not counted below.")
        print()

    if len(prefix_winners) == 1:
        winner = prefix_winners[0]
        print(f"RESULT one plugin prefix serves this path: /{winner}")
        print(f'       use: const UPSTREAM_PLUGIN_PREFIX = "/{winner}";')
        return 0

    if not prefix_winners:
        if None in winners:
            print("RESULT no plugin prefix answered. Only the host root did, which is the")
            print("       gateway's own API, not a plugin route. Check the plugin key the")
            print("       upstream gateway was actually installed under; it is not")
            print("       necessarily the key in your meta.key.")
        else:
            print("RESULT no prefix answered as a JSON API.")
            print("       Either the upstream is down, the path is wrong for this vendor,")
            print("       or every call is being intercepted before it reaches the gateway.")
        return 1

    print(f"RESULT {len(prefix_winners)} plugin prefixes answered: {prefix_winners}")
    print("       More than one means the upstream serves this path at several roots.")
    print("       Compare the messages above; pick the one whose error names a task,")
    print("       not the one that echoes a plugin key back.")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
