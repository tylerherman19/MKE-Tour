# MKE Tour — Doors Open Milwaukee 2026 route

A static walking-route planner for 11 downtown Doors Open Milwaukee stops (Sep 26–27, 2026).

- Leaflet map with real walking routes between stops (precomputed from OpenStreetMap / OSRM foot routing, stored in `data.js`)
- Drag (or ▲/▼) to reorder; the map, walk times, distances and arrival times update live
- Sat / Sun switch: stops closed that day are flagged and left off the route
- "Suggest best order" finds the order with the earliest finish that respects each stop's hours
- Apple Maps links for the full route, each leg, and each stop (Google Maps link as backup)

Hours come from the Historic Milwaukee 9/24/26 printable site list.

## Run

Open `index.html` via any static server, or enable GitHub Pages (Settings → Pages → deploy from branch, root).
