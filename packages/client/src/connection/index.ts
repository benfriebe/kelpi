/**
 * The client's transport layer: one socket, three concerns.
 *
 *   `socket.ts`   — handshake, framing, heartbeat, reconnect (`NexConnection`)
 *   `commands.ts` — control-protocol verbs as promises (`CommandClient`) + UI-only reports
 *   `pty.ts`      — per-pane terminal streams with ack-based flow control (`PtyClient`)
 *
 * Nothing here knows about React or the store; `state/bridge.ts` wires them together.
 */

export {
    DEFAULT_WS_PATH,
    NexConnection,
    SOCKET_OPEN,
    createConnection,
    defaultSocketFactory,
    resolveWsUrl,
    tokenFromLocation,
    type AttentionMessage,
    type BackoffOptions,
    type ConnectionError,
    type ConnectionEventName,
    type ConnectionEvents,
    type ConnectionListener,
    type ConnectionStatus,
    type NexConnectionOptions,
    type PtyResyncMessage,
    type SocketCloseLike,
    type SocketFactory,
    type SocketLike,
    type SocketMessageLike
} from './socket';

export {
    CommandClient,
    CommandDisconnectedError,
    CommandError,
    CommandTimeoutError,
    DEFAULT_COMMAND_TIMEOUT_MS,
    WORKTREE_COMMAND_TIMEOUT_MS,
    createCommandClient,
    isOkReply,
    replyError,
    replyNumber,
    replySearchMatch,
    replyText,
    unwrapReply,
    wirePayload,
    type CommandClientOptions,
    type CommandReply,
    type PaneScope,
    type SendOptions,
    type TerminalSearchMatch
} from './commands';

export {
    PtyClient,
    createPtyClient,
    type PtyClientOptions,
    type PtyStreamHandle,
    type PtySubscription
} from './pty';

export {
    FakeWebSocket,
    completeHandshake,
    createFakeSocketFactory,
    emptySnapshotState,
    type FakeSocketHarness,
    type HandshakeOptions
} from './testing';
