# @pipeworx/ioos-erddap

US Integrated Ocean Observing System data — buoys, tide gauges, gliders, HF radar currents, water
quality and regional ocean model grids — read live from the IOOS regional associations' ERDDAP
servers.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ioos_erddap_search_datasets(query, protocol?, node?, limit?)` — full-text search of one node's
  catalogue. Start here: every other tool takes a `dataset_id` from these results.
- `ioos_erddap_dataset_info(dataset_id, node?)` — variables, units, axes, time coverage, licence.
- `ioos_erddap_tabledap(dataset_id, variables?, constraints?, node?, limit?)` — station and glider
  timeseries rows.
- `ioos_erddap_griddap_point(dataset_id, variable, latitude, longitude, time?, depth?, node?)` —
  one gridded value from a regional model or radar grid.

## Auth

Keyless. Every node serves anonymously.

## Data sources

Six nodes, selected with `node`. A dataset lives on exactly one of them, so getting `node` right is
the first thing a caller has to do; a wrong id raises an error that lists them all.

| `node` | Server | Coverage |
|---|---|---|
| `national` | <https://erddap.ioos.us/erddap> | IOOS-wide inventories, asset and metric datasets |
| `sensors` (default) | <https://erddap.sensors.ioos.us/erddap> | the national in-situ sensor network |
| `gliders` | <https://gliders.ioos.us/erddap> | every US underwater glider deployment |
| `pacioos` | <https://pae-paha.pacioos.hawaii.edu/erddap> | Hawaii and the Pacific Islands; ROMS and WRF grids |
| `secoora` | <https://erddap.secoora.org/erddap> | the US Southeast |
| `gcoos` | <https://erddap.gcoos.org/erddap> | the Gulf of Mexico |

**NERACOOS and NANOOS are deliberately absent.** `https://www.neracoos.org/erddap` and
`https://data.nanoos.org/erddap` both answer 301 from our egress (measured 2026-09-17). Adding them
without resolving where they redirect would ship two node ids that fail for every caller. If you
add them, verify a live search first, not just a reachable root.

## Traps

Protocol-level traps live in `shared/src/erddap.ts` (shared with `noaa-coastwatch`) and are
documented in full at the top of that file. Two matter most here:

- **`erddap.ioos.us` has almost no griddap.** The national node is inventories and metrics; the
  gridded fields are on the regional nodes. A `griddap_point` call against `national` is not a bug.
- **PacIOOS ROMS grids are 4-D: time, depth, latitude, longitude.** `depth` is required on those,
  and omitting it is an axis error rather than a defaulted surface reading. `depth: 0.25` is the
  shallowest level of `roms_hiig`.

And the one this pack found the hard way: **ERDDAP's first `&`-segment is positional** — the server
reads it as the variable list whatever it contains. Asking for every column (no `variables`) while
dropping the now-empty first segment slides the row-cap expression into the variable slot and the
server answers `Unrecognized variable="orderByLimit("5")"`, which reads as a broken dataset rather
than a malformed URL. The shared client keeps the empty segment.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ioos-erddap": {
      "url": "https://gateway.pipeworx.io/ioos-erddap/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ioos-erddap/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ioos_erddap_search_datasets \
  -H 'Content-Type: application/json' \
  -d '{"query":"water temperature","node":"sensors","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ioos_erddap_search_datasets`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-ioos-erddap` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/ioos-erddap/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "ioos-erddap": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ioos-erddap"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ioos Erddap data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
