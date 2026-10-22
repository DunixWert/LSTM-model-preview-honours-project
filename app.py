"""Local showcase for the solar export LSTMs. Run: python app.py, then open http://127.0.0.1:5000"""

import sys
import uuid
import webbrowser
import pandas as pd
from flask import Flask, jsonify, render_template, request

from model_service import WEATHER, Forecaster, InputError, load_builtin, load_upload

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024

print("Loading dataset and models (about 30 s)...")
SOURCES = {"builtin": load_builtin()}
FORECASTER = Forecaster()
print("Ready on http://127.0.0.1:5000")


def _source(key):
    if key not in SOURCES:
        raise InputError("That upload has expired. Upload the file again.")
    return SOURCES[key]


@app.errorhandler(InputError)
def _input_error(e):
    return jsonify({"error": str(e)}), 400


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/meta")
def meta():
    return jsonify({"source": "builtin", **SOURCES["builtin"].meta(), "weather": WEATHER})


@app.post("/api/upload")
def upload():
    f = request.files.get("file")
    if f is None or not f.filename:
        raise InputError("Choose a file first.")
    src = load_upload(f)
    key = uuid.uuid4().hex[:12]
    # Keep only the latest few uploads in memory
    for old in [k for k in SOURCES if k != "builtin"][:-4]:
        del SOURCES[old]
    SOURCES[key] = src
    return jsonify({"source": key, **src.meta()})


def _range(a):
    try:
        return int(a["site"]), pd.Timestamp(a["start"]), pd.Timestamp(a["end"])
    except (KeyError, ValueError, TypeError):
        raise InputError("Bad site or date range.")


@app.get("/api/forecast")
def forecast():
    a = request.args
    site, start, end = _range(a)
    return jsonify(FORECASTER.forecast(_source(a.get("source", "builtin")), site, start, end, a.get("mask") == "1"))


@app.post("/api/scenario")
def scenario():
    body = request.get_json(force=True)
    site, start, end = _range(body)
    return jsonify(
        FORECASTER.scenario(
            _source(body.get("source", "builtin")), site, start, end,
            body.get("overrides", {}), bool(body.get("mask")),
        )
    )


if __name__ == "__main__":
    if "--open" in sys.argv:
        webbrowser.open("http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False)
