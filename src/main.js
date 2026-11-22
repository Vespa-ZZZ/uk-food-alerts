import { Actor, log } from 'apify';
import { runActor, sanitize } from './run.js';

try {
    await Actor.init();
    await runActor({ actor: Actor, log });
    await Actor.exit();
} catch (error) {
    const message = sanitize(error?.message ?? error);
    log.error(message);
    await Actor.fail(message);
}
