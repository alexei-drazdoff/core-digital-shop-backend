/**
 * Per supplier circuit breaker.
 *
 * Stops a dead supplier from consuming the timeout budget of every order in the
 * queue. Closed is normal, open short circuits immediately, half open lets a
 * single probe through to test recovery.
 *
 * Note what it deliberately does NOT do: an open circuit reports `circuit_open`,
 * which the delivery path treats as indeterminate rather than as a refusal. A
 * breaker knows the supplier is unreachable now; it cannot know whether an
 * earlier call already issued a code.
 */
export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly openMs: number;
  readonly now?: () => number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly now: () => number;

  constructor(
    readonly name: string,
    private readonly options: CircuitBreakerOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  /** True when a call may proceed. Transitions open into half_open once the cooldown elapses. */
  allowsRequest(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'half_open') return true;
    if (this.now() - this.openedAt >= this.options.openMs) {
      this.state = 'half_open';
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    // A failed probe sends the breaker straight back to open rather than
    // spending the whole threshold again on a supplier that is still down.
    if (this.state === 'half_open' || this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  currentState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.options.openMs) return 'half_open';
    return this.state;
  }
}
