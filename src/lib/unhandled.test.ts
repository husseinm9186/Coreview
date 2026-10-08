import { describe, expect, it } from 'vitest';
import { describeRejection, watchUnhandled } from './unhandled';

describe('a promise nobody caught', () => {
  it('describes whatever was thrown in one line, and never throws itself', () => {
    expect(describeRejection(new Error('Local database error: locked'))).toBe('Local database error: locked');
    expect(describeRejection('That device has no address to connect to.')).toBe('That device has no address to connect to.');
    expect(describeRejection({ message: 'refused' })).toBe('refused');
    expect(describeRejection({ code: 7 })).toBe('{"code":7}');
    expect(describeRejection(undefined)).toBe('Something failed.');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeRejection(cyclic)).toBe('Something failed.');
  });

  it('hears the window\'s unhandledrejection and can stop hearing it', () => {
    const listeners = new Map<string, (e: Event) => void>();
    const target = {
      addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => listeners.set(type, fn as (e: Event) => void),
      removeEventListener: (type: string) => listeners.delete(type),
    } as unknown as Window;
    const heard: string[] = [];
    const stop = watchUnhandled(target, (line) => heard.push(line));
    listeners.get('unhandledrejection')!({ reason: new Error('no vault') } as unknown as Event);
    expect(heard).toEqual(['no vault']);
    stop();
    expect(listeners.has('unhandledrejection')).toBe(false);
  });
});
