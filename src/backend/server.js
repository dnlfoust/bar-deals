// server.js — Charlotte Bar Deals backend
// Requirements: Node 18+, Postgres + PostGIS, .env with PORT, DATABASE_URL, ADMIN_TOKEN

const express = require("express");
const cors = require("cors");
const pool = require("./db");
require("dotenv").config();

const app = express();

// --- Middleware ---
app.use(cors({
  origin: [
    "http://localhost",
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ],
  allowedHeaders: ["Content-Type", "x-admin-token"]
}));
app.use(express.json());
app.use(express.text({ type: "text/csv" })); // for CSV import

// --- Helpers ---
async function geocodeIfNeeded({ address, lat, lon }) {
  if (lat != null && lon != null) return { lat, lon };
  if (!address) return { lat: null, lon: null };
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`;
  const resp = await fetch(url, { headers: { "User-Agent": "CharlotteBarDeals/1.0" } });
  const data = await resp.json();
  if (Array.isArray(data) && data.length) {
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  }
  return { lat: null, lon: null };
}

function toTimestamp(dt) { return dt ? new Date(dt) : null; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addWeeks(d, n) { return addDays(d, n * 7); }

async function insertEvent(ev) {
  const { name, type, description, address_name, address, lat, lon, start_time, end_time } = ev;
  let locSql = "NULL";
  const params = [name, type, description || null, address_name || null, address || null, start_time, end_time || null];
  if (lat != null && lon != null) {
    params.push(lon, lat); // lon then lat
    locSql = `ST_SetSRID(ST_MakePoint($${params.length - 1}, $${params.length}), 4326)::geography`;
  }
  const q = `
    INSERT INTO events (name, type, description, address_name, address, location, start_time, end_time)
    VALUES ($1, $2, $3, $4, $5, ${locSql}, $6, $7)
    RETURNING id`;
  const { rows } = await pool.query(q, params);
  return rows[0].id;
}

// Compute date/time-of-day window
function boundsFor(date, timeOfDay) {
  // Morning   = 05:00:00 – 11:59:59
  // Afternoon = 12:00:00 – 16:59:59
  // Evening   = 17:00:00 – 23:59:59
  // Anytime/empty = full day
  const tod = (timeOfDay || "").toLowerCase();
  let startHH = "00:00:00";
  let endHH = "23:59:59";
  if (tod === "morning") { startHH = "05:00:00"; endHH = "11:59:59"; }
  else if (tod === "afternoon") { startHH = "12:00:00"; endHH = "16:59:59"; }
  else if (tod === "evening") { startHH = "17:00:00"; endHH = "23:59:59"; }
  return [`${date} ${startHH}`, `${date} ${endHH}`];
}

// -------------------- Public: /events --------------------
app.get("/events", async (req, res) => {
  try {
    const { lat, lng, radius, date, timeOfDay } = req.query;

    // ---------- Robust multi-type parsing ----------
    // Accept: ?types=Drink Deals,Trivia  OR  ?type=Drink Deals&type=Trivia  OR  ?types[]=...
    const raw = []
      .concat(req.query.types ?? [])
      .concat(req.query.type ?? [])
      .concat(req.query["types[]"] ?? []);

    let types = [];
    for (const item of raw) {
      if (Array.isArray(item)) {
        for (const v of item) {
          types.push(...String(v).split(","));
        }
      } else if (item != null) {
        types.push(...String(item).split(","));
      }
    }
    types = [...new Set(types.map(s => s.trim()).filter(Boolean).map(s => s.toLowerCase()))];
    // ------------------------------------------------

    // Date window helper
    function boundsFor(d, tod) {
      const t = (tod || "").toLowerCase();
      let startHH = "00:00:00", endHH = "23:59:59";
      if (t === "morning")   { startHH = "05:00:00"; endHH = "11:59:59"; }
      else if (t === "afternoon") { startHH = "12:00:00"; endHH = "16:59:59"; }
      else if (t === "evening")   { startHH = "17:00:00"; endHH = "23:59:59"; }
      return [`${d} ${startHH}`, `${d} ${endHH}`];
    }

    const params = [];
    let q = `
      SELECT id, name, type, description, address_name, address,
             ST_X(ST_Transform(location::geometry, 4326)) AS lon,
             ST_Y(ST_Transform(location::geometry, 4326)) AS lat,
             start_time, end_time
      FROM events
      WHERE 1=1
    `;

    // Type filter (case-insensitive, with explicit cast to text[])
    if (types.length) {
      params.push(types);
      q += ` AND LOWER(type) = ANY($${params.length}::text[])`;
    }

    // Date / time-of-day filter
    if (date) {
      const [fromTs, toTs] = boundsFor(date, timeOfDay);
      params.push(fromTs, toTs);
      q += ` AND start_time >= $${params.length - 1} AND start_time <= $${params.length}`;
    } else {
      q += ` AND start_time >= NOW()`;
    }

    // Radius (mi → m)
    if (lat && lng && radius) {
      params.push(parseFloat(lng), parseFloat(lat), parseFloat(radius) * 1609.34);
      q += ` AND location IS NOT NULL AND ST_DWithin(
        location,
        ST_SetSRID(ST_MakePoint($${params.length - 2}, $${params.length - 1}), 4326)::geography,
        $${params.length}
      )`;
    }

    q += ` ORDER BY start_time ASC LIMIT 200;`;

    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------- Health / Debug --------------------
app.get("/healthz", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT now() AS db_time;");
    res.json({ ok: true, db_time: rows[0].db_time });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "DB unreachable" });
  }
});

app.get("/debug/db", async (req, res) => {
  try {
    const out = {};
    const t1 = await pool.query("SELECT now() AS now;");
    out.now = t1.rows[0].now;
    try {
      const t2 = await pool.query("SELECT PostGIS_Version() AS postgis;");
      out.postgis = t2.rows?.[0]?.postgis || null;
    } catch {
      out.postgis = null;
    }
    const t3 = await pool.query("SELECT to_regclass('public.events') AS has_events;");
    out.has_events_table = !!t3.rows[0].has_events;
    res.json({ ok: true, checks: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/debug/token", (req, res) => {
  res.json({
    received: req.header("x-admin-token") || null,
    expected_is_set: !!process.env.ADMIN_TOKEN
  });
});

// -------------------- Admin auth --------------------
function requireAdmin(req, res, next) {
  const token = req.header("x-admin-token");
  if (!process.env.ADMIN_TOKEN) {
    return res.status(500).json({ error: "ADMIN_TOKEN not set on server" });
  }
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// -------------------- Admin routes --------------------
app.get("/admin/events", requireAdmin, async (req, res) => {
  try {
    const q = `
      SELECT id, name, type, description, address_name, address,
             ST_X(ST_Transform(location::geometry, 4326)) AS lon,
             ST_Y(ST_Transform(location::geometry, 4326)) AS lat,
             start_time, end_time
      FROM events
      ORDER BY start_time DESC
      LIMIT 500`;
    const { rows } = await pool.query(q);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: "Server error" }); }
});

app.post("/admin/events", requireAdmin, async (req, res) => {
  try {
    const {
      name, type, description, address_name, address,
      lat, lon, start_time, end_time,
      recurrence = "none", recurrence_until = null
    } = req.body;

    if (!name || !type || !start_time) {
      return res.status(400).json({ error: "name, type, start_time are required" });
    }

    const geo = await geocodeIfNeeded({ address, lat, lon });

    // Expand recurrence
    const instances = [];
    const start = toTimestamp(start_time);
    const end = toTimestamp(end_time);
    const until = recurrence_until
      ? new Date(recurrence_until)
      : (recurrence === "daily" ? addDays(start, 30)
        : recurrence === "weekly" ? addWeeks(start, 8)
        : start);

    let currentStart = new Date(start);
    let currentEnd = end ? new Date(end) : null;
    const step = recurrence === "daily" ? (d) => addDays(d, 1)
      : recurrence === "weekly" ? (d) => addWeeks(d, 1)
      : null;

    if (!step) {
      instances.push({ start: currentStart, end: currentEnd });
    } else {
      while (currentStart <= until) {
        instances.push({ start: new Date(currentStart), end: currentEnd ? new Date(currentEnd) : null });
        currentStart = step(currentStart);
        if (currentEnd) currentEnd = step(currentEnd);
        if (instances.length > 200) break;
      }
    }

    const ids = [];
    for (const inst of instances) {
      const id = await insertEvent({
        name, type, description, address_name, address,
        lat: geo.lat, lon: geo.lon,
        start_time: inst.start, end_time: inst.end
      });
      ids.push(id);
    }

    res.json({ success: true, inserted: ids.length, ids });
  } catch (e) { console.error(e); res.status(500).json({ error: "Server error" }); }
});

app.put("/admin/events/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, type, description, address_name, address,
      lat, lon, start_time, end_time
    } = req.body;

    if (!name || !type || !start_time) {
      return res.status(400).json({ error: "name, type, start_time are required" });
    }

    const geo = await geocodeIfNeeded({ address, lat, lon });

    const params = [name, type, description || null, address_name || null, address || null, start_time, end_time || null];
    let setLoc = "";
    if (geo.lat != null && geo.lon != null) {
      params.push(geo.lon, geo.lat); // $8, $9
      setLoc = `, location = ST_SetSRID(ST_MakePoint($8, $9), 4326)::geography`;
    }
    params.push(id);

    const q = `
      UPDATE events
      SET name=$1, type=$2, description=$3, address_name=$4, address=$5, start_time=$6, end_time=$7
          ${setLoc}
      WHERE id=$${setLoc ? 10 : 8}`;

    await pool.query(q, params);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Server error" }); }
});

app.delete("/admin/events/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM events WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Server error" }); }
});

app.post("/admin/events/:id/duplicate", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`
      SELECT name, type, description, address_name, address,
             ST_X(ST_Transform(location::geometry, 4326)) AS lon,
             ST_Y(ST_Transform(location::geometry, 4326)) AS lat,
             start_time, end_time
      FROM events WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    const ev = rows[0];
    const newId = await insertEvent(ev);
    res.json({ success: true, id: newId });
  } catch (e) { console.error(e); res.status(500).json({ error: "Server error" }); }
});

// CSV import: name,type,address_name,description,address,start_time,end_time,recurrence,recurrence_until,lat,lon
app.post("/admin/import", requireAdmin, async (req, res) => {
  try {
    const csv = req.body || "";
    const lines = csv.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return res.status(400).json({ error: "Empty CSV" });

    const header = lines.shift().split(",").map(h => h.trim().toLowerCase());
    const idx = (h) => header.indexOf(h);
    const required = ["name", "type", "start_time"];
    for (const r of required) if (idx(r) === -1) return res.status(400).json({ error: `Missing column: ${r}` });

    let inserted = 0;

    for (const line of lines) {
      const parts = line.split(",");
      const rec = Object.fromEntries(header.map((h, i) => [h, parts[i] ? parts[i].trim() : ""]));

      const base = {
        name: rec.name,
        type: rec.type,
        address_name: rec.address_name || null,
        description: rec.description || null,
        address: rec.address || null,
        start_time: rec.start_time || null,
        end_time: rec.end_time || null
      };

      const lat = rec.lat ? parseFloat(rec.lat) : null;
      const lon = rec.lon ? parseFloat(rec.lon) : null;
      const geo = await geocodeIfNeeded({ address: base.address, lat, lon });

      const recurrence = (rec.recurrence || "none").toLowerCase();
      const recurrence_until = rec.recurrence_until || null;
      const start = toTimestamp(base.start_time);
      const end = toTimestamp(base.end_time);
      const until = recurrence_until ? new Date(recurrence_until)
        : (recurrence === "daily" ? addDays(start, 30)
          : recurrence === "weekly" ? addWeeks(start, 8)
          : start);

      let currentStart = new Date(start);
      let currentEnd = end ? new Date(end) : null;
      const step = recurrence === "daily" ? (d) => addDays(d, 1)
        : recurrence === "weekly" ? (d) => addWeeks(d, 1)
        : null;

      const instances = [];
      if (!step) {
        instances.push({ start: currentStart, end: currentEnd });
      } else {
        while (currentStart <= until) {
          instances.push({ start: new Date(currentStart), end: currentEnd ? new Date(currentEnd) : null });
          currentStart = step(currentStart);
          if (currentEnd) currentEnd = step(currentEnd);
          if (instances.length > 200) break;
        }
      }

      for (const inst of instances) {
        await insertEvent({
          ...base,
          lat: geo.lat, lon: geo.lon,
          start_time: inst.start, end_time: inst.end
        });
        inserted++;
      }
    }

    res.json({ success: true, inserted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
