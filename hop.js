// The Hop streetcar, live. Car positions come from TransLoc's public map feed (undocumented), polled
// every 30 s while the page is visible. Stop arrival times aren't published, so they're estimated
// from each car's position along the track and the scheduled run time of each stretch, like the
// Hop's own map. If the feed errors, everything falls back to the bundled snapshot and schedule.
(function () {
  "use strict";

  var BASE = "https://thehopmke.transloc.com/Services/JSONPRelay.svc/";
  var POLL = 30e3, IDLE_POLL = 120e3, STALE = 180, KEY = "mke-hop";
  var SNAP = window.HOP_SNAPSHOT;
  var mem = load() || {};
  var routes = {}, active = (mem.active || SNAP.active).slice(), cars = [], listeners = [];
  var st = { live: false, at: 0, err: null, count: mem.count || SNAP.cars, source: "snapshot" };
  var timer = null, inflight = false, emptyPolls = 0;

  function load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ active: active, count: st.count })); } catch (e) {} }

  // ---------- geometry ----------
  function decode(str) {
    var i = 0, lat = 0, lng = 0, out = [];
    while (i < str.length) {
      var b, shift = 0, res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32);
      lat += res & 1 ? ~(res >> 1) : res >> 1;
      shift = 0; res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32);
      lng += res & 1 ? ~(res >> 1) : res >> 1;
      out.push([lat / 1e5, lng / 1e5]);
    }
    return out;
  }
  function meters(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  // Local flat projection (metres) around downtown, plenty accurate over a few km.
  var KX = 111320 * Math.cos(43.04 * Math.PI / 180), KY = 110540;
  function xy(p) { return [p[1] * KX, p[0] * KY]; }

  // A route is a loop of stops; each stop owns the stretch of track to the next stop.
  // s.t is the scheduled time (from the loop's start) a car reaches the stop.
  function build(r) {
    var t = 0, stops = r.stops.map(function (s, i) {
      var pts = s.pts || decode(s.g), len = 0;
      for (var k = 1; k < pts.length; k++) len += meters(pts[k - 1], pts[k]);
      var o = { id: s.id, i: i, name: s.name, ll: [s.lat, s.lng], sec: s.sec, dwell: s.dwell, pts: pts, len: len, t: t };
      t += s.dwell + s.sec;
      return o;
    });
    // The colour comes from a third-party feed and ends up in markup: accept only a hex colour.
    var color = /^#[0-9a-f]{3,8}$/i.test(r.color) ? r.color : "#6d27b8";
    return { id: r.id, name: r.name, color: color, stops: stops, loop: t };
  }
  SNAP.routes.forEach(function (r) { routes[r.id] = build(r); });

  // Where a car is on its route: stretch index, fraction along it, and its scheduled clock position.
  function locate(route, ll, heading, moving) {
    var p = xy(ll), best = null;
    route.stops.forEach(function (s) {
      var run = 0;
      for (var k = 1; k < s.pts.length; k++) {
        var a = xy(s.pts[k - 1]), b = xy(s.pts[k]), dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
        var seg = Math.sqrt(L2);
        var u = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
        var d = Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy);
        // Eastbound and westbound tracks share streets, so a moving car must face the stretch's way.
        if (moving && seg > 3) {
          var brg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360, diff = Math.abs(brg - heading) % 360;
          if (Math.min(diff, 360 - diff) > 100) d += 60;
        }
        if (!best || d < best.d) best = { d: d, stop: s, f: s.len ? Math.min(1, (run + u * seg) / s.len) : 0 };
        run += seg;
      }
    });
    if (!best || best.d > 120) return null;
    best.clock = best.stop.t + best.stop.dwell + best.f * best.stop.sec;
    return best;
  }
  function mod(a, n) { return ((a % n) + n) % n; }

  // Seconds until each on-route car reaches a stop, soonest first.
  function arrivals(route, stop) {
    var now = Date.now();
    return cars.filter(function (c) { return c.route === route.id && c.pos; }).map(function (c) {
      var age = c.age + (now - st.at) / 1000;
      // A car standing at the stop (or a few seconds past it) counts as there now, not a lap away.
      var eta = mod(stop.t - c.pos.clock + 90, route.loop) - 90 - age;
      if (eta < -30) eta += route.loop;
      return { car: c, eta: Math.max(0, eta) };
    }).sort(function (a, b) { return a.eta - b.eta; });
  }
  function headway(route) { return route.loop / Math.max(1, st.count || 1); }

  // ---------- feed ----------
  function get(path, ms) {
    var ctl = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 10000);
    return fetch(BASE + path, { cache: "no-store", signal: ctl && ctl.signal })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .finally(function () { clearTimeout(to); });
  }
  function loadRoutes() {
    return get("GetRoutesForMap?isPublicMap=true").then(function (list) {
      if (!Array.isArray(list) || !list.length) throw new Error("no routes");
      list.forEach(function (r) {
        var stops = (r.Stops || []).filter(function (s) { return s.MapPoints && s.MapPoints.length; })
          .sort(function (a, b) { return a.Order - b.Order; })
          .map(function (s) {
            return { id: s.RouteStopID, name: s.Description, lat: s.Latitude, lng: s.Longitude, sec: +s.SecondsToNextStop || 0, dwell: +s.SecondsAtStop || 0,
              pts: s.MapPoints.map(function (p) { return [p.Latitude, p.Longitude]; }) };
          });
        if (stops.length > 1) routes[r.RouteID] = build({ id: r.RouteID, name: String(r.Description || "").replace(/\s*THE HOP\s*$/i, ""), color: r.MapLineColor, stops: stops });
      });
      st.source = "live";
      emit();
    }).catch(function () { /* keep the snapshot */ });
  }
  function poll() {
    if (inflight) return;
    inflight = true;
    get("GetMapVehiclePoints?isPublicMap=true").then(function (list) {
      if (!Array.isArray(list)) throw new Error("bad feed");
      st.at = Date.now(); st.live = true; st.err = null;
      // TimeStamp is written in local time but labelled UTC (off by hours), so only Seconds is used for age.
      cars = list.filter(function (v) {
        return isFinite(v.Latitude) && isFinite(v.Longitude) && v.IsOnRoute !== false && (+v.Seconds || 0) <= STALE && routes[v.RouteID];
      }).map(function (v) {
        var c = { id: v.VehicleID, name: v.Name || "Streetcar", ll: [+v.Latitude, +v.Longitude], heading: +v.Heading || 0,
          mph: +v.GroundSpeed || 0, age: +v.Seconds || 0, route: v.RouteID };
        c.pos = locate(routes[c.route], c.ll, c.heading, c.mph > 2);
        return c;
      });
      if (cars.length) {
        active = cars.map(function (c) { return c.route; }).filter(function (id, i, a) { return a.indexOf(id) === i; });
        var perRoute = {};
        cars.forEach(function (c) { perRoute[c.route] = (perRoute[c.route] || 0) + 1; });
        st.count = Math.max.apply(null, Object.keys(perRoute).map(function (k) { return perRoute[k]; }));
        emptyPolls = 0;
        save();
      } else emptyPolls++;
    }).catch(function (e) {
      st.live = false; st.err = String(e && e.message || e);
      // Hold on to the last positions briefly, then drop them rather than show old cars.
      if (Date.now() - st.at > 120e3) cars = [];
    }).finally(function () {
      inflight = false;
      emit();
      schedule();
    });
  }
  function schedule() {
    clearTimeout(timer);
    if (document.visibilityState !== "visible") return;
    timer = setTimeout(poll, emptyPolls > 3 ? IDLE_POLL : POLL);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { if (Date.now() - st.at > POLL) poll(); else schedule(); }
    else clearTimeout(timer);
  });
  function emit() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }

  // ---------- trip planning ----------
  var WALK = 1.25, DETOUR = 1.25, NEAR = 700;
  function walkSec(a, b) { return meters(a, b) * DETOUR / WALK; }

  // Best Hop trip from one point to another: walk to a stop, wait, ride, walk on. With `inSec`
  // (seconds until you'd set off) under 15 min and a live feed, the wait uses real cars;
  // otherwise it's half the gap between cars.
  function trip(from, to, inSec) {
    inSec = inSec || 0;
    var best = null, useLive = st.live && cars.length && inSec < 900;
    active.forEach(function (rid) {
      var route = routes[rid];
      if (!route) return;
      var ons = route.stops.filter(function (s) { return meters(from, s.ll) <= NEAR; });
      var offs = route.stops.filter(function (s) { return meters(to, s.ll) <= NEAR; });
      ons.forEach(function (on) {
        var w1 = walkSec(from, on.ll), wait, live = false, arr = null;
        if (useLive) {
          arrivals(route, on).forEach(function (a) {
            for (var k = 0; k < 3; k++) {
              var t = a.eta + k * route.loop - inSec;
              if (t >= w1 + 30 && (arr == null || t < arr)) arr = t;
            }
          });
          if (arr != null) { wait = arr - w1; live = true; }
        }
        if (!live) wait = headway(route) / 2;
        offs.forEach(function (off) {
          if (off === on || off.name === on.name) return;
          var ride = mod(off.t - on.t, route.loop), w2 = walkSec(off.ll, to);
          var total = w1 + wait + ride + w2;
          if (!best || total < best.total) best = { route: route, on: on, off: off, walk1: w1, wait: wait, ride: ride, walk2: w2, total: total, live: live, carIn: live ? arr : null };
        });
      });
    });
    return best;
  }

  window.Hop = {
    start: function () { loadRoutes(); poll(); },
    onChange: function (f) { listeners.push(f); },
    status: function () { return st; },
    cars: function () { return cars; },
    routes: function () { return active.map(function (id) { return routes[id]; }).filter(Boolean); },
    arrivals: arrivals,
    trip: trip,
    headway: headway
  };
})();
