// Minimal working backend for Charlotte Bar Deals
// Node 18+ recommended (has global fetch). For Node 16, install node-fetch.

const express = require("express");
const cors = require("cors");
const pool = require("./db");
require("dotenv").config();

const app = express(); // <-- important: create the express app

app.use(cors({ origin: ['http://localhost:3000','http://127.0.0.1:3000', 'http://localhost'] }));              // allow requests from your frontend
app.use(express.json());      // parse JSON bodies
app.use(express.text({ type: "text/csv" })); // for CSV import route

// ---------- Helpers ----------
async function geocodeIfNeeded({ address, lat, lon }) {
  // If lat/lon already provided, trust them
  if (lat != null && lon != null) return { lat, lon };
  if (!address) return { lat: null, lon: null };

  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`;
  const resp = await fetch(url, { headers: { "User-Agent": "CharlotteBarDeals/1.0" }});
  const data = await resp.json();
  if (Array.isArray(data) && data.length) {
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  }
  return { lat: null, lon: null };
}

function toTimestamp(dt) { return dt ? new Date(dt) : null; }
function addDays(d, n){ const x = new Date(d); x.setDate(x.getDate()+n); return x; }
function addWeeks(d, n){ return addDays(d, n*7); }

async function insertEvent(ev) {
  const { name, type, description, address_name, address, lat, lon, start_time, end_time } = ev;
  let locSql = "NULL";
  const params = [name, type, description || null, address_name || null, address || null, start_time, end_time || null];
  if (lat != null && lon != null) {
    params.push(lon, lat); // lon then lat
    locSql = `ST_SetSRID(ST_MakePoint($${params.length-1}, $${params.length}), 4326)::geography`;
  }
  const q = `
    INSERT INTO events (name, type, description, address_name, address, location, start_time, end_time)
    VALUES ($1, $2, $3, $4, $5, ${locSql}, $6, $7)
    RETURNING id`;
  const { rows } = await pool.query(q, params);
  return rows[0].id;
}

// ---------- Public route: /events ----------
app.get("/events", async (req, res) => {
  try {
    const { lat, lng, radius, date } = req.query;

    // Parse multi-types:
    // - Prefer "types" CSV (types=Drink Deals,Trivia)
    // - Also support repeated ?type=...
    let types = [];
    if (req.query.types) {
      types = String(req.query.types)
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
    } else if (req.query.type) {
      types = Array.isArray(req.query.type) ? req.query.type : [req.query.type];
      types = types.map(s => s.trim()).filter(Boolean);
    }

    const params = [];
    let q = `
      SELECT id, name, type, description, address_name, address,
             ST_X(ST_AsText(ST_Transform(location::geometry, 4326))) AS lon,
             ST_Y(ST_AsText(ST_Transform(location::geometry, 4326))) AS lat,
             start_time, end_time
      FROM events
      WHERE 1=1
    `;

    if (types.length) {
      params.push(types.map(t => t.toLowerCase()));           // $1
      q += ` AND LOWER(type) = ANY($${params.length})`;       // compare case-insensitively
    }

    if (date) {
      params.push(date);
      q += ` AND DATE(start_time) = $${params.length}`;
    }

    if (lat && lng && radius) {
      params.push(parseFloat(lng), parseFloat(lat), parseFloat(radius) * 1609.34);
      q += ` AND ST_DWithin(
        location,
        ST_SetSRID(ST_MakePoint($${params.length-2}, $${params.length-1}), 4326)::geography,
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

// ---------- Admin auth ----------
function requireAdmin(req, res, next){
  const token = req.header("x-admin-token");
  if (!process.env.ADMIN_TOKEN) return res.status(500).json({ error: "ADMIN_TOKEN not set on server" });
  if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ---------- Admin routes ----------
app.get("/admin/events", requireAdmin, async (req, res) => {
  try {
    const q = `
      SELECT id, name, type, description, address_name, address,
             ST_X(ST_AsText(ST_Transform(location::geometry, 4326))) AS lon,
             ST_Y(ST_AsText(ST_Transform(location::geometry, 4326))) AS lat,
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

    if (!name || !type || !start_time) return res.status(400).json({ error: "name, type, start_time are required" });

    // Geocode if needed
    const geo = await geocodeIfNeeded({ address, lat, lon });

    // Recurrence expansion
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
    const step = recurrence === "daily" ? (d)=>addDays(d,1)
               : recurrence === "weekly" ? (d)=>addWeeks(d,1)
               : null;

    if (!step) {
      instances.push({ start: currentStart, end: currentEnd });
    } else {
      while (currentStart <= until) {
        instances.push({ start: new Date(currentStart), end: currentEnd ? new Date(currentEnd) : null });
        currentStart = step(currentStart);
        if (currentEnd) currentEnd = step(currentEnd);
        if (instances.length > 200) break; // safety cap
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

    if (!name || !type || !start_time) return res.status(400).json({ error: "name, type, start_time are required" });

    const geo = await geocodeIfNeeded({ address, lat, lon });

    const params = [name, type, description || null, address_name || null, address || null, start_time, end_time || null, id];
    let setLoc = "";
    if (geo.lat != null && geo.lon != null) {
      params.splice(7, 0, geo.lon, geo.lat); // push before id
      setLoc = `, location = ST_SetSRID(ST_MakePoint($8, $9), 4326)::geography`;
      params.push(id); // move id to end
    }

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
  try { await pool.query("DELETE FROM events WHERE id=$1", [req.params.id]); res.json({ success: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: "Server error" }); }
});

// Duplicate an event
app.post("/admin/events/:id/duplicate", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`
      SELECT name, type, description, address_name, address,
             ST_X(ST_AsText(ST_Transform(location::geometry, 4326))) AS lon,
             ST_Y(ST_AsText(ST_Transform(location::geometry, 4326))) AS lat,
             start_time, end_time
      FROM events WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    const ev = rows[0];
    const newId = await insertEvent(ev);
    res.json({ success: true, id: newId });
  } catch (e) { console.error(e); res.status(500).json({ error: "Server error" }); }
});

// CSV import
// Columns: name,type,address_name,description,address,start_time,end_time,recurrence,recurrence_until,lat,lon
app.post("/admin/import", requireAdmin, async (req, res) => {
  try {
    const csv = req.body || "";
    const lines = csv.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return res.status(400).json({ error: "Empty CSV" });
    const header = lines.shift().split(",").map(h => h.trim().toLowerCase());

    const idx = h => header.indexOf(h);
    const required = ["name","type","start_time"];
    for (const r of required) if (idx(r) === -1) return res.status(400).json({ error: `Missing column: ${r}` });

    let inserted = 0;

    for (const line of lines) {
      const parts = line.split(",");
      const rec = Object.fromEntries(header.map((h,i)=>[h, parts[i] ? parts[i].trim() : "" ]));

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
      const end   = toTimestamp(base.end_time);
      const until = recurrence_until ? new Date(recurrence_until)
                  : (recurrence === "daily" ? addDays(start, 30)
                  :  recurrence === "weekly" ? addWeeks(start, 8)
                  :  start);

      let currentStart = new Date(start);
      let currentEnd   = end ? new Date(end) : null;
      const step = recurrence === "daily" ? (d)=>addDays(d,1)
                 : recurrence === "weekly" ? (d)=>addWeeks(d,1)
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

// ---------- Start server ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
