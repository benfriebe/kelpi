/** One outstanding message plus its latest replacement. Shared by window-owned feeds. */
export interface WindowFeed {
    /**
     * True only when `sequence` matched the one outstanding frame. A stale, duplicate or
     * malformed acknowledgement returns false, so a caller may treat a true result as this
     * consumer's liveness signal without a wedged view keeping itself alive by replaying an ack.
     */
    ack(sequence: unknown): boolean;
    dispose(): void;
}
export function createWindowFeed<T>(
    topic: string,
    subscribe: (listener: (value: T) => void, onError: (error: Error) => void) => () => void,
    send: (message: { type: string; sequence: number; value?: T; error?: string }) => void
): WindowFeed {
    type Delivery = { value: T } | { error: Error };
    let disposed = false, sequence = 0, outstanding: number | null = null, latest: Delivery | null = null;
    let stop = (): void => {};
    const dispose = (): void => { disposed = true; latest = null; outstanding = null; stop(); };
    const flush = (): void => {
        if (disposed || outstanding !== null || latest === null) return;
        const delivery = latest; latest = null;
        if (sequence === Number.MAX_SAFE_INTEGER) { dispose(); return; }
        outstanding = ++sequence;
        try {
            send('value' in delivery ? { type: topic, sequence, value: delivery.value }
                : { type: `${topic}-error`, sequence, error: delivery.error.message.slice(0, 4096) });
        } catch { dispose(); }
    };
    const offer = (delivery: Delivery): void => { if (!disposed) { latest = delivery; flush(); } };
    stop = subscribe(value => offer({ value }), error => offer({ error }));
    if (disposed) stop();
    return { ack(value) { if (disposed || outstanding === null || value !== outstanding) return false; outstanding = null; flush(); return true; }, dispose };
}
