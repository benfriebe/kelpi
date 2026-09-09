/** One outstanding message plus its latest replacement. Shared by window-owned feeds. */
export interface WindowFeed {
    ack(sequence: unknown): void;
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
    return { ack(value) { if (!disposed && outstanding !== null && value === outstanding) { outstanding = null; flush(); } }, dispose };
}
