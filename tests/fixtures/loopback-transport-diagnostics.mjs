// Test-only observation: no dispatcher changes, extra requests, retries or deadlines.
import { channel } from 'node:diagnostics_channel';
import { writeFileSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export function observeLoopbackTransport(port) {
  const started = performance.now();
  const lag = monitorEventLoopDelay({ resolution: 20 });
  const events = [];
  const connections = new WeakMap();
  const subscriptions = [];
  lag.enable();
  const elapsed = () => Math.round(performance.now() - started);
  const record = event => { if (events.length < 64) events.push({ atMs: elapsed(), ...event }); };
  const subscribe = (name, observer) => {
    const topic = channel(name);
    topic.subscribe(observer);
    subscriptions.push(() => topic.unsubscribe(observer));
  };
  for (const event of ['beforeConnect', 'connected', 'connectError']) {
    subscribe(`undici:client:${event}`, ({ connectParams, error, socket }) => {
      if (connectParams?.hostname !== '127.0.0.1' || (port !== undefined && Number(connectParams.port) !== port)) return;
      if (event === 'beforeConnect') connections.set(connectParams, elapsed());
      record({ event, port: Number(connectParams.port),
        ...(connections.has(connectParams) ? { connectMs: elapsed() - connections.get(connectParams) } : {}),
        ...(error ? { error: error.name, code: error.code, syscall: error.syscall } : {}),
        ...(socket ? { localPort: socket.localPort, remotePort: socket.remotePort } : {}),
      });
    });
  }
  for (const event of ['create', 'headers', 'error']) {
    subscribe(`undici:request:${event}`, ({ request, response, error }) => {
      if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(String(request?.origin))
        || (port !== undefined && Number(new URL(request.origin).port) !== port)) return;
      record({ event: `request.${event}`, port: Number(new URL(request.origin).port),
        ...(response ? { status: response.statusCode } : {}),
        ...(error ? { error: error.name, code: error.code, syscall: error.syscall } : {}),
      });
    });
  }
  return {
    snapshot: () => ({ node: process.version, elapsedMs: elapsed(), maxEventLoopDelayMs: Math.round(lag.max / 1e6), events: [...events] }),
    dispose: () => { lag.disable(); for (const unsubscribe of subscriptions) unsubscribe(); },
  };
}

const destination = process.env.DKB_TEST_TRANSPORT_DIAGNOSTICS;
if (destination) {
  const observation = observeLoopbackTransport();
  process.once('exit', () => {
    observation.dispose();
    writeFileSync(destination, JSON.stringify(observation.snapshot()));
  });
}
