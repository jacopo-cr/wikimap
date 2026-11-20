# Wikipedia, Live
<img width="908" height="652" alt="wikimap" src="https://github.com/user-attachments/assets/e3767007-baa6-4f0f-86e5-df99d5e7d8e8" />

**[Live Demo](https://jacopo-cr.github.io/wikimap/)**

A real-time world map and live feed of human edits to geotagged Wikipedia articles.

## How It Works
1. **Live Stream:** Connects directly from the browser to Wikimedia's `recentchange` Server-Sent Events (SSE) stream and filters for human edits to main-namespace Wikipedia articles.
2. **Coordinate Batching:** Groups incoming article titles per language edition and queries the MediaWiki Action API (`prop=coordinates&origin=*`) in batches of up to 50 titles, caching results in memory.
3. **Smoothed Canvas Map:** Renders `world-atlas` land polygons with a Natural Earth projection, simplifies coastlines with Douglas-Peucker + quadratic B-spline smoothing, and caches the static map on an offscreen canvas.
4. **Synced Animations:** Each geotagged edit pops in with an expanding language-colored pulse ring and slides into the bottom feed bar.

## Language Colors
`EN` Terracotta · `DE` Slate Blue · `FR` Ochre · `ES` Sage · `RU` Amber · `JA` Plum · `IT` Teal · `PT` Mauve · `Other` Warm Gray
