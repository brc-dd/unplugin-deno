# `config/`

Planned for M1: the pure-TypeScript config layer (no wasm) described in
[docs/architecture.md §3](../../../../docs/architecture.md#3-config-layer-srcconfig-pure-typescript-no-wasm):
`deno.json(c)` discovery, workspaces with glob members and `links`, import maps with scopes and
package expansion, the `deno.lock` v5 reader, `nodeModulesDir` detection and the assembled
`Project`. It never imports `core/` or `hosts/`.
