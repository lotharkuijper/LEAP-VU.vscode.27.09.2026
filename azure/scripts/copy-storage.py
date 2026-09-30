"""Kopieert alle buckets en bestanden uit Supabase Storage naar de Storage op Azure.

Leest alleen uit het oude project. Bestanden die op Azure al bestaan worden
overschreven, dus vlak voor de overstap kan dit opnieuw.

Omgeving:
  SOURCE_URL, SOURCE_KEY   adres van het oude project en de service_role-sleutel ervan
  TARGET_URL, TARGET_KEY   adres van Supabase op Azure en de service_role-sleutel ervan
Start via copy-storage.sh, dat de TARGET_*-waarden uit Key Vault haalt.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request


def request(base, key, method, path, body=None, headers=None):
    req = urllib.request.Request(f"{base}/storage/v1{path}", data=body, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return resp.read(), resp.headers
    except urllib.error.HTTPError as err:
        err.msg = f"{err.msg} ({method} {path}): {err.read()[:500].decode(errors='replace')}"
        raise


def upload(base, key, path, data, mimetype, attempts=4):
    """Probeert opnieuw bij een serverfout: de opslagdienst kan nog aan het starten zijn."""
    for attempt in range(1, attempts + 1):
        try:
            return request(base, key, "POST", path, data, {"Content-Type": mimetype, "x-upsert": "true"})
        except urllib.error.HTTPError as err:
            if err.code < 500 or attempt == attempts:
                raise
            time.sleep(5 * attempt)


def call_json(base, key, method, path, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    data, _ = request(base, key, method, path, body, {"Content-Type": "application/json"})
    return json.loads(data) if data else None


def list_files(base, key, bucket, prefix=""):
    """Geeft (pad, mimetype) voor elk bestand onder prefix; mappen hebben geen id."""
    offset = 0
    while True:
        page = call_json(base, key, "POST", f"/object/list/{bucket}",
                         {"prefix": prefix, "limit": 1000, "offset": offset,
                          "sortBy": {"column": "name", "order": "asc"}})
        for item in page:
            path = f"{prefix}{item['name']}"
            if item.get("id") is None:
                yield from list_files(base, key, bucket, f"{path}/")
            else:
                yield path, (item.get("metadata") or {}).get("mimetype") or "application/octet-stream"
        if len(page) < 1000:
            return
        offset += 1000


def main():
    src, src_key = os.environ["SOURCE_URL"].rstrip("/"), os.environ["SOURCE_KEY"]
    dst, dst_key = os.environ["TARGET_URL"].rstrip("/"), os.environ["TARGET_KEY"]

    for bucket in call_json(src, src_key, "GET", "/bucket"):
        settings = {k: bucket.get(k) for k in ("id", "name", "public", "file_size_limit", "allowed_mime_types")}
        try:
            call_json(dst, dst_key, "POST", "/bucket", settings)
            print(f"bucket {bucket['id']}: aangemaakt")
        except urllib.error.HTTPError as err:
            if err.code not in (400, 409):  # bestaat al
                raise
            print(f"bucket {bucket['id']}: bestaat al")

        copied = 0
        for path, mimetype in list_files(src, src_key, bucket["id"]):
            quoted = urllib.parse.quote(path, safe="/")
            data, _ = request(src, src_key, "GET", f"/object/{bucket['id']}/{quoted}")
            upload(dst, dst_key, f"/object/{bucket['id']}/{quoted}", data, mimetype)
            copied += 1
        print(f"bucket {bucket['id']}: {copied} bestanden gekopieerd")


if __name__ == "__main__":
    main()
