"""
Builds model inputs exactly as Starting_Model/data_processing.py does, runs the
Champion Model and Baseline BiLSTM, and computes metrics and what-if forecasts.

One difference from training: windows are built per site, so a window never
mixes the end of one site with the start of the next.
"""

import os
import threading
import numpy as np
import pandas as pd

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
import keras  # noqa: E402

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "Starting_Model")
DATASET_PATH = os.path.join(MODEL_DIR, "dataset.xlsx")

TIMESTEPS = 24
N_SITES = 7

# Physical min/max used by normalize.py (MinMaxScaler). Recovered from
# analyzeData/7_Sites_WeatherData_Combined_Hourly.xlsx; rescaling that file with
# these values reproduces dataset.xlsx exactly. Units are Open-Meteo defaults.
WEATHER = [
    {"col": "shortwave_radiation", "label": "Irradiance", "unit": "W/m²", "min": 0.0, "max": 1152.0, "step": 10},
    {"col": "cloud_cover", "label": "Cloud cover", "unit": "%", "min": 0.0, "max": 100.0, "step": 1},
    {"col": "temperature_2m", "label": "Temperature", "unit": "°C", "min": -4.3, "max": 40.5, "step": 0.5},
    {"col": "precipitation", "label": "Precipitation", "unit": "mm", "min": 0.0, "max": 22.2, "step": 0.1},
    {"col": "relative_humidity_2m", "label": "Relative humidity", "unit": "%", "min": 3.0, "max": 100.0, "step": 1},
    {"col": "wind_speed_10m", "label": "Wind speed", "unit": "km/h", "min": 0.0, "max": 49.6, "step": 0.5},
]
WEATHER_COLS = [w["col"] for w in WEATHER]
SITE_COLS = [f"IsSite{i}" for i in range(1, N_SITES + 1)]
FEATURE_COLS = ["hour_sin", "hour_cos", "month_sin", "month_cos", "ExpkWh_t-1"] + WEATHER_COLS + SITE_COLS

# Column positions in the feature matrix
I_HOUR = (0, 1)
I_MONTH = (2, 3)
I_LAG = 4
I_WEATHER = {c: 5 + k for k, c in enumerate(WEATHER_COLS)}
I_SITE = 11

REQUIRED_UPLOAD_COLS = ["Timestamp", "Site_Name", "ExpkWh"] + WEATHER_COLS


class InputError(ValueError):
    """A problem with user-supplied data, shown to the user as-is."""


def _hour_month_encoding(hour, month):
    return (
        np.sin(2 * np.pi * hour / 24.0), np.cos(2 * np.pi * hour / 24.0),
        np.sin(2 * np.pi * month / 12.0), np.cos(2 * np.pi * month / 12.0),
    )


class Source:
    """A dataset split into per-site feature matrices, ready to window."""

    def __init__(self, df, name):
        self.name = name
        self.sites = {}
        for site, g in df.groupby("Site_Name"):
            g = g.sort_values("Timestamp").reset_index(drop=True)
            if len(g) <= TIMESTEPS:
                continue
            g["Hour"] = g["Timestamp"].dt.hour
            g["Month"] = g["Timestamp"].dt.month
            hs, hc, ms, mc = _hour_month_encoding(g["Hour"].values, g["Month"].values)
            g["hour_sin"], g["hour_cos"], g["month_sin"], g["month_cos"] = hs, hc, ms, mc
            g["ExpkWh_t-1"] = g["ExpkWh"].shift(1).fillna(0.0)
            for i, col in enumerate(SITE_COLS, start=1):
                g[col] = 1.0 if int(site) == i else 0.0
            self.sites[int(site)] = {
                "ts": g["Timestamp"].values,
                "hour": g["Hour"].values,
                "month": g["Month"].values,
                "X": g[FEATURE_COLS].to_numpy(dtype="float32"),
                "y": g["ExpkWh"].to_numpy(dtype="float64"),
            }
        if not self.sites:
            raise InputError(f"Every site needs more than {TIMESTEPS} consecutive hourly rows.")

    def meta(self):
        return {
            "name": self.name,
            "sites": [
                {
                    "site": s,
                    # first forecastable hour is row TIMESTEPS
                    "start": pd.Timestamp(d["ts"][TIMESTEPS]).isoformat(),
                    "end": pd.Timestamp(d["ts"][-1]).isoformat(),
                }
                for s, d in sorted(self.sites.items())
            ],
        }

    def site(self, site):
        if site not in self.sites:
            raise InputError(f"Site {site} is not in {self.name}.")
        return self.sites[site]


def load_builtin():
    df = pd.read_excel(DATASET_PATH, sheet_name="Sheet1")
    return Source(df, "Built-in dataset")


def load_upload(file_storage):
    filename = (file_storage.filename or "").lower()
    try:
        if filename.endswith(".csv"):
            df = pd.read_csv(file_storage)
        elif filename.endswith((".xlsx", ".xls")):
            df = pd.read_excel(file_storage, sheet_name=0)
        else:
            raise InputError("Upload a .csv or .xlsx file.")
    except InputError:
        raise
    except Exception as e:
        raise InputError(f"Could not read the file: {e}")

    missing = [c for c in REQUIRED_UPLOAD_COLS if c not in df.columns]
    if missing:
        raise InputError("Missing columns: " + ", ".join(missing))

    df = df[REQUIRED_UPLOAD_COLS].copy()
    df["Timestamp"] = pd.to_datetime(df["Timestamp"], errors="coerce")
    # Accept 3 or "Site 3"
    df["Site_Name"] = pd.to_numeric(
        df["Site_Name"].astype(str).str.extract(r"(\d+)")[0], errors="coerce"
    )
    for c in ["ExpkWh"] + WEATHER_COLS:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    bad = df.isna().any(axis=1)
    if bad.any():
        first = int(bad.idxmax()) + 2  # +2: header row and 1-based rows
        raise InputError(f"{int(bad.sum())} rows have empty or non-numeric values (first at row {first}).")
    if not df["Site_Name"].between(1, N_SITES).all():
        raise InputError(f"Site_Name must be between 1 and {N_SITES}.")
    out_of_range = [c for c in WEATHER_COLS if df[c].min() < -1e-6 or df[c].max() > 1 + 1e-6]
    if out_of_range:
        raise InputError(
            "Weather columns must be MinMax scaled to 0..1 like dataset.xlsx. "
            "Out of range: " + ", ".join(out_of_range)
        )
    df["Site_Name"] = df["Site_Name"].astype(int)
    return Source(df, file_storage.filename)


def zero_mask(pred, hour, target_irradiance):
    """ADR 0004: zero at astronomical night (GHI = 0 or hour 20..05), otherwise max(0, y)."""
    pred = np.maximum(pred, 0.0)
    night = (target_irradiance <= 0) | (hour >= 20) | (hour <= 5)
    return np.where(night, 0.0, pred)


def metrics(y, p):
    r = y - p
    mse = float(np.mean(r ** 2))
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    return {
        "mse": mse,
        "rmse": float(np.sqrt(mse)),
        "mae": float(np.mean(np.abs(r))),
        "r2": float(1 - np.sum(r ** 2) / ss_tot) if ss_tot > 0 else None,
    }


class Forecaster:
    def __init__(self):
        self._lock = threading.Lock()
        self.models = {
            "champion": keras.models.load_model(os.path.join(MODEL_DIR, "best_optuna_model.keras")),
            "baseline": keras.models.load_model(os.path.join(MODEL_DIR, "baseline_bilstm_model.keras")),
        }

    def _predict(self, name, X):
        # predict_on_batch skips predict()'s per-call setup, which otherwise makes
        # each slider move take about a second. The lock keeps TensorFlow to one
        # request at a time under Flask's threaded server.
        with self._lock:
            return np.asarray(self.models[name].predict_on_batch(X)).reshape(-1).astype("float64")

    @staticmethod
    def _rows(d, start, end):
        ts = pd.to_datetime(d["ts"])
        rows = np.where((ts >= start) & (ts <= end))[0]
        rows = rows[rows >= TIMESTEPS]
        if len(rows) == 0:
            raise InputError("No forecastable hours in that range for this site.")
        if len(rows) > 24 * 31:
            raise InputError("Pick a range of 31 days or less.")
        return rows

    def _run(self, d, rows, X, target_hours, mask):
        irr = d["X"][rows, I_WEATHER["shortwave_radiation"]]
        out = {}
        for name in self.models:
            p = self._predict(name, X)
            if mask:
                p = zero_mask(p, target_hours, irr)
            out[name] = p
        return out

    def forecast(self, source, site, start, end, mask):
        d = source.site(site)
        rows = self._rows(d, start, end)
        X = d["X"][rows[:, None] + np.arange(-TIMESTEPS, 0)]
        y = d["y"][rows]
        preds = self._run(d, rows, X, d["hour"][rows], mask)
        view = d["X"][rows]
        means = {
            spec["col"]: float(spec["min"] + view[:, I_WEATHER[spec["col"]]].mean() * (spec["max"] - spec["min"]))
            for spec in WEATHER
        }
        means["export"] = float(y.mean())
        return {
            "timestamps": [pd.Timestamp(t).isoformat() for t in d["ts"][rows]],
            "actual": y.tolist(),
            "series": {name: p.tolist() for name, p in preds.items()},
            "metrics": {name: metrics(y, p) for name, p in preds.items()},
            "means": means,
        }

    def scenario(self, source, site, start, end, overrides, mask):
        """Re-forecast every hour in the range after changing its 24 h input window.

        overrides: site and month (absolute, 0 or missing keeps the real value),
        hour_shift (hours added to every row's clock), export_scale (fraction applied
        to the export history), and per weather column an offset in physical units.
        """
        d = source.site(site)
        rows = self._rows(d, start, end)
        idx = rows[:, None] + np.arange(-TIMESTEPS, 0)
        base = d["X"][idx]
        w = base.copy()

        new_site = int(overrides.get("site") or 0)
        if not 0 <= new_site <= N_SITES:
            raise InputError(f"Site must be between 1 and {N_SITES}.")
        if new_site:
            w[..., I_SITE:I_SITE + N_SITES] = 0.0
            w[..., I_SITE + new_site - 1] = 1.0

        shift = int(overrides.get("hour_shift", 0))
        new_month = int(overrides.get("month") or 0)
        if not 0 <= new_month <= 12:
            raise InputError("Month must be between 1 and 12.")
        if shift or new_month:
            hours = (d["hour"][idx] + shift) % 24
            months = np.full(idx.shape, new_month) if new_month else d["month"][idx]
            hs, hc, ms, mc = _hour_month_encoding(hours, months)
            w[..., I_HOUR[0]], w[..., I_HOUR[1]], w[..., I_MONTH[0]], w[..., I_MONTH[1]] = hs, hc, ms, mc

        w[..., I_LAG] = base[..., I_LAG] * float(overrides.get("export_scale", 1.0))

        daylight = base[..., I_WEATHER["shortwave_radiation"]] > 0
        for spec in WEATHER:
            offset = float(overrides.get(spec["col"], 0.0))
            if offset == 0:
                continue
            k = I_WEATHER[spec["col"]]
            shifted = np.clip(base[..., k] + offset / (spec["max"] - spec["min"]), 0.0, 1.0)
            # Irradiance only changes in daylight rows; night stays dark.
            w[..., k] = np.where(daylight, shifted, base[..., k]) if spec["col"] == "shortwave_radiation" else shifted

        preds = self._run(d, rows, w, (d["hour"][rows] + shift) % 24, mask)
        return {"series": {name: p.tolist() for name, p in preds.items()}}
