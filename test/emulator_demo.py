"""Send only synthetic settings to an already running SDK emulator."""
import json
import argparse
from datetime import datetime, timezone, timedelta
from libpebble2.communication import PebbleConnection
from libpebble2.communication.transports.websocket import MessageTargetPhone
from libpebble2.communication.transports.websocket.protocol import (
    AppConfigSetup, AppConfigResponse, WebSocketPhonesimAppConfig, WebSocketPhonesimConfigResponse,
)
from pebble_tool.sdk.emulator import ManagedEmulatorTransport

parser = argparse.ArgumentParser()
parser.add_argument("platform", nargs="?", default="basalt")
parser.add_argument("--contract-start", default="", help="Synthetic supply start date YYYY-MM-DD")
args = parser.parse_args()
transport = ManagedEmulatorTransport(args.platform)
connection = PebbleConnection(transport)
connection.connect()
connection.run_async()
transport.send_packet(WebSocketPhonesimAppConfig(config=AppConfigSetup()), target=MessageTargetPhone())
connection.read_transport_message(MessageTargetPhone, WebSocketPhonesimConfigResponse, timeout=15)
values = {
    "month": datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m"),
    "contractStartDate": args.contract_start,
    "basicMode": "month", "basicRate": "100", "rate1": "10", "rate2": "30",
    "bandStart": "09:00", "bandEnd": "21:00", "fuelRate": "-1", "governmentRate": "2",
    "taxMode": "excluded", "taxRate": "10", "demo": True,
    "email": "", "password": "", "clearCredentials": False,
}
transport.send_packet(WebSocketPhonesimAppConfig(config=AppConfigResponse(data=json.dumps(values))), target=MessageTargetPhone())
print("Synthetic demo settings sent; no real authentication used")
