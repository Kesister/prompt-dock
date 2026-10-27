// Registration state is separate from the saved preference: a temporary startup
// conflict must not disable a shortcut or require the user to save it again.
class ShortcutRegistration {
  constructor({ globalShortcut, callback, onChange = () => {},
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.globalShortcut = globalShortcut;
    this.callback = callback;
    this.onChange = onChange;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.shortcut = '';
    this.registeredShortcut = '';
    this.error = '';
    this.retryTimer = null;
    this.retryAttempts = 0;
    this.disposed = false;
  }

  isRegistered() {
    try {
      return Boolean(this.shortcut && this.registeredShortcut === this.shortcut
        && this.globalShortcut.isRegistered(this.shortcut));
    } catch { return false; }
  }

  attempt(shortcut) {
    try {
      return this.globalShortcut.register(shortcut, this.callback)
        ? { ok: true } : { ok: false, reason: 'unavailable' };
    } catch { return { ok: false, reason: 'invalid' }; }
  }

  cancelRetry() {
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }

  scheduleRetry() {
    if (this.disposed || !this.shortcut || this.retryTimer !== null) return;
    const delays = [1000, 3000, 10000, 30000, 60000];
    const delay = delays[Math.min(this.retryAttempts++, delays.length - 1)];
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.recover();
    }, delay);
    this.retryTimer?.unref?.();
  }

  // A settings edit is transactional: register the replacement before releasing
  // the working key, and never retry a rejected, unsaved replacement later.
  set(shortcut) {
    if (this.disposed) return { ok: false, reason: 'disposed' };
    if (!shortcut) { this.clear(); return { ok: true }; }
    if (shortcut === this.shortcut) return this.recover();
    const result = this.attempt(shortcut);
    if (!result.ok) return result;
    const previous = this.registeredShortcut;
    this.cancelRetry();
    this.shortcut = this.registeredShortcut = shortcut;
    this.error = '';
    this.retryAttempts = 0;
    if (previous && previous !== shortcut) this.globalShortcut.unregister(previous);
    this.onChange();
    return result;
  }

  // Only persisted preferences use this path. Failed registrations remain desired
  // and are retried without modifying settings or choosing a different key.
  restore(shortcut) {
    if (this.disposed) return { ok: false, reason: 'disposed' };
    if (shortcut === this.shortcut) return this.recover();
    this.clear(false);
    this.shortcut = shortcut || '';
    return this.recover();
  }

  recover() {
    if (this.disposed) return { ok: false, reason: 'disposed' };
    this.cancelRetry();
    if (!this.shortcut || this.isRegistered()) return { ok: true };
    const result = this.attempt(this.shortcut);
    this.registeredShortcut = result.ok ? this.shortcut : '';
    this.error = result.ok ? '' : result.reason;
    if (result.ok) this.retryAttempts = 0;
    else if (result.reason === 'unavailable') this.scheduleRetry();
    this.onChange();
    return result;
  }

  clear(notify = true) {
    this.cancelRetry();
    const previous = this.registeredShortcut;
    this.shortcut = this.registeredShortcut = this.error = '';
    this.retryAttempts = 0;
    if (previous) this.globalShortcut.unregister(previous);
    if (notify) this.onChange();
  }

  dispose() {
    this.clear(false);
    this.disposed = true;
  }
}

module.exports = { ShortcutRegistration };
