"""One-off read-only look at the TeamUp calendar. Prints structure only; names are masked
because this repo's Action logs are public."""
import json, os, urllib.request, collections
from datetime import date, timedelta
KEY, CAL = os.environ["TEAMUP_KEY"].strip(), os.environ["CALENDAR_KEY"].strip().rstrip("/").split("/")[-1]
def get(path):
    req = urllib.request.Request(f"https://api.teamup.com/{CAL}{path}", headers={"Teamup-Token": KEY})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, path, e.read()[:300]); return None
def mask(s):
    s = (s or "").strip()
    return "<empty>" if not s else f"{s[0]}{'*'*(len(s)-1)}({len(s)})"
def walk(o, p=""):
    if isinstance(o, dict):
        for k, v in o.items():
            q = f"{p}.{k}"
            if any(w in k.lower() for w in ("perm", "access", "role", "readonly", "modif", "admin", "timezone", "tz")):
                print("  cfg", q, "=", json.dumps(v)[:120])
            walk(v, q)
conf = get("/configuration")
if conf:
    print("configuration keys:", list(conf.keys())); walk(conf)
subs = get("/subcalendars")
if subs:
    for s in subs.get("subcalendars", []):
        print("subcal", s.get("id"), repr(s.get("name")), "active", s.get("active"), "readonly", s.get("readonly"),
              {k: s[k] for k in s if k not in ("id", "name", "active", "readonly", "color", "overlap", "type", "attributes", "creation_dt", "update_dt", "parent_id", "nesting_level")})
t = date.today()
ev = get(f"/events?startDate={t-timedelta(days=60)}&endDate={t+timedelta(days=14)}")
if ev:
    E = ev.get("events", [])
    print("events:", len(E))
    if E: print("event keys:", sorted(E[0].keys()))
    c = collections.Counter()
    for e in E:
        c["who_empty"] += not (e.get("who") or "").strip()
        c["title_empty"] += not (e.get("title") or "").strip()
        c["who_eq_title"] += (e.get("who") or "").strip().lower() == (e.get("title") or "").strip().lower()
        c["has_custom"] += bool(e.get("custom"))
        c["all_day"] += bool(e.get("all_day"))
        c["recurring"] += bool(e.get("rrule"))
    print("counts:", dict(c))
    print("subcal ids used:", collections.Counter(tuple(e.get("subcalendar_ids", [])) for e in E))
    for e in sorted(E, key=lambda e: e["start_dt"])[-25:]:
        print(" ", e["start_dt"][:16], e["end_dt"][11:16], "who", mask(e.get("who")), "title", mask(e.get("title")),
              "custom", list((e.get("custom") or {}).keys()), "loc", mask(e.get("location")), "notes", bool(e.get("notes")),
              "signup", e.get("signup_enabled"), "readonly", e.get("readonly"))
    if E: print("tz sample:", E[0]["start_dt"], E[0].get("tz"))
