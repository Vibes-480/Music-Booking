"""Music room check. GitHub Actions runs this every 15 minutes.

1. Alerts: a push through ntfy when a booking appears or changes and its name is missing
   or not on the known-people list (edited in the app's People tab).
2. Reminders: for MY_NAME's bookings, a push 30 minutes before the start and
   10 minutes before the end, scheduled with ntfy so they arrive on time.

Never changes anything in TeamUp. Remembers what it has seen in state.json (kept in the
Actions cache, not in the repo). Prints no names: this repo's logs are public.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta

STATE = "state.json"
START_REMINDER_MIN = 30
END_REMINDER_MIN = 10


def env(name, default=""):
    return (os.environ.get(name) or default).strip()


def http(url, method="GET", headers=None, body=None):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def known_map():
    out = {}
    for entry in json.loads(env("KNOWN_PEOPLE", "[]") or "[]"):
        parts = [p.strip() for p in str(entry).split("=") if p.strip()]
        for p in parts:
            out[p.lower()] = parts[0]
    return out


def name_of(ev):
    return (ev.get("who") or "").strip() or (ev.get("title") or "").strip()


def ts(s):
    return datetime.fromisoformat(s).timestamp()


def when(ev):
    s, e = datetime.fromisoformat(ev["start_dt"]), datetime.fromisoformat(ev["end_dt"])
    return f"{s:%a %d/%m} {s:%H:%M}–{e:%H:%M}"


def notify(title, message, at=None, priority="high", tags="musical_keyboard"):
    headers = {"Title": title.encode("utf-8"), "Priority": priority, "Tags": tags}
    if at and at > time.time() + 15:
        headers["At"] = str(int(at))
    if env("APP_URL"):
        headers["Click"] = env("APP_URL")
    http(f"https://ntfy.sh/{env('NTFY_TOPIC')}", "POST", headers, message.encode("utf-8"))


def fetch_events():
    today = date.today()
    q = f"startDate={today - timedelta(days=1)}&endDate={today + timedelta(days=60)}"
    if env("SUBCALENDAR_ID"):
        q += f"&subcalendarId[]={env('SUBCALENDAR_ID')}"
    cal = env("CALENDAR_KEY").rstrip("/").split("/")[-1]  # accepts the key or the whole link
    data = http(f"https://api.teamup.com/{cal}/events?{q}",
                headers={"Teamup-Token": env("TEAMUP_KEY")})
    return [e for e in data.get("events", []) if not e.get("all_day")]


def main():
    now = time.time()
    try:
        state = json.load(open(STATE))
    except (OSError, ValueError):
        state = {}
    first_run = "seen" not in state
    seen, reminded = state.get("seen", {}), state.get("reminded", {})
    known, me = known_map(), env("MY_NAME", "Ronny").lower()
    events = fetch_events()

    alerts = []
    for ev in events:
        key, ver = str(ev["id"]), str(ev.get("version") or ev.get("update_dt") or "")
        changed = seen.get(key) != ver
        seen[key] = ver
        if first_run or not changed or ts(ev["end_dt"]) < now:
            continue
        name = name_of(ev)
        if not name:
            alerts.append(f"No name: {when(ev)}")
        elif name.lower() != me and name.lower() not in known:
            alerts.append(f"{name}: {when(ev)}")

    sent_reminders = 0
    for ev in events:
        if name_of(ev).lower() != me:
            continue
        start, end = ts(ev["start_dt"]), ts(ev["end_dt"])
        k_start, k_end = f"s|{ev['id']}|{ev['start_dt']}", f"e|{ev['id']}|{ev['end_dt']}"
        if k_start not in reminded and now < start <= now + 75 * 60:
            notify("Music room in 30 min", f"Your booking starts at {datetime.fromisoformat(ev['start_dt']):%H:%M}. Time to head over.",
                   at=start - START_REMINDER_MIN * 60, priority="default", tags="alarm_clock")
            reminded[k_start] = now
            sent_reminders += 1
        if k_end not in reminded and start <= now + 35 * 60 and now < end <= now + 35 * 60:
            notify("Music room: 10 min left", f"Your booking ends at {datetime.fromisoformat(ev['end_dt']):%H:%M}.",
                   at=end - END_REMINDER_MIN * 60, priority="default", tags="hourglass")
            reminded[k_end] = now
            sent_reminders += 1

    if alerts:
        title = "Unknown music room booking" if len(alerts) == 1 else f"{len(alerts)} unknown music room bookings"
        notify(title, "\n".join(alerts))

    live = {str(e["id"]) for e in events}
    state = {"seen": {k: v for k, v in seen.items() if k in live},
             "reminded": {k: v for k, v in reminded.items() if v > now - 3 * 86400}}
    json.dump(state, open(STATE, "w"))
    print(f"{len(events)} bookings checked. {'First run: remembered them, no alerts.' if first_run else f'{len(alerts)} alert(s) sent.'} {sent_reminders} reminder(s) scheduled.")


if __name__ == "__main__":
    if "--test-alert" in sys.argv:
        notify("Music room test", "Alerts are working 🎹", priority="default")
        print("Test push sent.")
    else:
        main()
