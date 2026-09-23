/**
 * Output multibyte text from a file, not synthetic CDP key events. In the baseline run,
 * that input path produced zsh <00xx> octet escapes in the server capture, before replay.
 */
export const MULTIBYTE_RESIZE_STORM_SCRIPT =
    "printf '┌── 日本語テスト %s ✅ 🚀 あいうえお漢字 你好世界 ──┐\\n' \"$1\" | tee \"$HOME/r.out\"\n";

export const multibyteResizeStormLine = (round) =>
    `┌── 日本語テスト ${String(round)} ✅ 🚀 あいうえお漢字 你好世界 ──┐`;
