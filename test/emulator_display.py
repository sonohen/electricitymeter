"""Display explicit synthetic fixtures; never contact the electricity API."""
import argparse
import json
import time
from pathlib import Path
from uuid import UUID
from libpebble2.communication import PebbleConnection
from libpebble2.services.appmessage import AppMessageService, CString
from pebble_tool.sdk.emulator import ManagedEmulatorTransport

parser = argparse.ArgumentParser()
parser.add_argument("platform")
parser.add_argument("state", choices=["demo", "cached", "real-cached", "real-updating", "first-update", "compound", "wide-status", "medium", "long", "long-usage", "unknown-bands", "overflow", "unset", "missing", "auth", "network", "updating", "delayed", "partial", "zero"])
parser.add_argument("--capture", help="Write the emulator screenshot to this local file")
args = parser.parse_args()
connection = PebbleConnection(ManagedEmulatorTransport(args.platform))
connection.connect()
connection.run_async()
app = AppMessageService(connection)
package = json.loads((Path(__file__).resolve().parents[1] / "package.json").read_text())
payload = {
    0: "DEMO - sample usage", 1: "JPY 379", 2: "JPY 5861", 3: "14.40 kWh",
    4: "2026-10 / 2 days", 5: "10/03 12:00 JST", 6: "Through 10/02",
    9: "7.20", 10: "7.20",
    8: "CURRENT BREAKDOWN\nBase 38.71\nBand 1 72.00\nBand 2 216.00\nFuel -14.40\nGovt -28.80\nRenewable 60.19\nAdded tax 34.37\nTotal JPY 379\n\nFORECAST BREAKDOWN\nBase 600.00\nBand 1 1116.00\nBand 2 3348.00\nFuel -223.20\nGovt -446.40\nRenewable 932.98\nAdded tax 532.74\nTotal JPY 5861",
}
if args.state == "cached":
    payload[0] = "DEMO / Update failed"
    payload[6] = "Through 10/02; Network unavailable"
if args.state == "updating":
    payload[0] = "DEMO / Updating"
    payload[6] = "Through 10/02; Updating"
if args.state == "real-cached":
    payload[0] = "Cached / Update failed"
    payload[6] = "Through 10/02; Network unavailable"
if args.state == "real-updating":
    payload[0] = "Cached / Updating"
    payload[6] = "Through 10/02; Updating"
if args.state == "compound":
    payload[0] = "DEMO / Cached / Updating"
    payload[6] = "Through 10/02; Updating"
if args.state == "wide-status":
    payload[0] = "DEMO / Cached / Updating / missing / delayed data"
    payload[6] = "Through 10/02; 1d behind; missing 10/03; Updating"
if args.state == "medium":
    payload[1] = "JPY 12345"
    payload[2] = "JPY 123456"
if args.state in ("long", "overflow"):
    payload[1] = "JPY 1234567"
    payload[2] = "JPY 9007199254740991"
    payload[8] = "DEMO DISPLAY ONLY\nCurrent JPY 1234567\nForecast JPY 9007199254740991"
    if args.state == "overflow":
        payload[2] = "JPY 123456789012345678901234567"
        payload[8] = "DEMO DISPLAY ONLY\nOverlong string tests full text fallback"
if args.state == "zero":
    payload[1] = payload[2] = "JPY 0"
    payload[3] = "0.00 kWh"
    payload[9] = payload[10] = "0.00"
    payload[8] = "DEMO DISPLAY ONLY\nCurrent JPY 0\nForecast JPY 0"
if args.state == "long-usage":
    payload[9] = "1234567.89"
    payload[10] = "9876543.21"
    payload[8] = "DEMO DISPLAY ONLY\nLong usage text tests details fallback"
if args.state == "unknown-bands":
    payload[9] = payload[10] = "--"
if args.state == "delayed":
    payload[0] = "Estimate / delayed data"
    payload[6] = "Through 10/02; 1d behind"
if args.state == "partial":
    payload[0] = "Estimate / missing / delayed data"
    payload[6] = "Through 10/02; 1d behind; missing 10/03"
if args.state in ("unset", "missing", "auth", "network"):
    payload[0] = "Unavailable"
    payload[1] = payload[2] = payload[3] = payload[8] = "--"
    payload[9] = payload[10] = "--"
    payload[6] = {"unset": "Set rates for this month", "missing": "Missing half-hour data",
                  "auth": "Re-enter login on phone", "network": "Network unavailable"}[args.state]
    payload[4] = "2026-10"
    payload[5] = "--"
if args.state == "first-update":
    payload[0] = "Updating"
    payload[1] = payload[2] = payload[3] = payload[5] = payload[8] = "--"
    payload[9] = payload[10] = "--"
    payload[4] = "2026-10"
    payload[6] = "Please wait"
app.send_message(UUID(package["pebble"]["uuid"]), {key: CString(value) for key, value in payload.items()})
time.sleep(0.5)
print("Synthetic display fixture sent:", args.platform, args.state)
if args.capture:
    import png
    from libpebble2.services.screenshot import Screenshot
    screenshot = Screenshot(connection).grab_image()
    png.from_array(screenshot, mode="RGB;8").save(args.capture)
    print("Saved visual test:", Path(args.capture).name)
