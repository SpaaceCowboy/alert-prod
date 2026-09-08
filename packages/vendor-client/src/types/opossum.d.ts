declare module 'opossum' {
  export interface Options {
    timeout?: number;
    errorThresholdPercentage?: number;
    resetTimeout?: number;
    volumeThreshold?: number;
    name?: string;
  }

  export default class CircuitBreaker<TInput, TResult> {
    constructor(action: (input: TInput) => Promise<TResult>, options?: Options);
    readonly opened: boolean;
    readonly halfOpen: boolean;
    fire(input: TInput): Promise<TResult>;
    on(event: 'open' | 'close' | 'halfOpen', listener: () => void): this;
    shutdown(): void;
  }
}
