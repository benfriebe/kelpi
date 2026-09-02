// @kelpi/core is consumed via subpath exports: @kelpi/core/layout, /codec, /resolve, /agent, /env, /icon, /config.
// A flat barrel is deliberately avoided: layout/ and agent/ declare structurally identical
// PaneStatus/AgentKind types, and layout/codec.ts keeps a conformance-test-local copy of the
// layout JSON codec (canonical one lives in codec/pane-layout-json.ts).
export {};
