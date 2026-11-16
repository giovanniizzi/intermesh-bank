package it.intermesh.bank.util;

import io.vertx.core.Future;
import io.vertx.core.Vertx;
import io.vertx.core.json.JsonObject;
import io.vertx.ext.web.Session;
import io.vertx.ext.web.sstore.LocalSessionStore;
import io.vertx.ext.web.sstore.SessionStore;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Function;

/** Keeps Vert.x local sessions terminal after destruction, including late response flushes. */
public final class TerminalLocalSessionStore implements SessionStore {
    private static final String WRAPPER = TerminalLocalSessionStore.class.getName();
    private final LocalSessionStore delegate;

    public TerminalLocalSessionStore(LocalSessionStore delegate) {
        this.delegate = delegate;
    }

    @Override
    public SessionStore init(Vertx vertx, JsonObject options) {
        throw new UnsupportedOperationException("The local store is already initialized");
    }

    @Override public long retryTimeout() { return delegate.retryTimeout(); }
    @Override public Session createSession(long timeout) { return wrap(delegate.createSession(timeout)); }
    @Override public Session createSession(long timeout, int length) {
        return wrap(delegate.createSession(timeout, length));
    }

    private LocalSession wrap(Session session) {
        synchronized (session) {
            if (session.isDestroyed()) {
                return null;
            }
            LocalSession wrapper = session.get(WRAPPER);
            if (wrapper == null) {
                wrapper = new LocalSession(session);
                session.put(WRAPPER, wrapper);
            }
            return wrapper;
        }
    }

    @Override
    public Future<Session> get(String id) {
        return delegate.get(id).map(raw -> {
            LocalSession session = raw == null ? null : wrap(raw);
            if (session != null) {
                synchronized (session) {
                    if (session.isDestroyed()) {
                        return null;
                    }
                    if (System.currentTimeMillis() - session.lastAccessed() > session.timeout()) {
                        session.destroy();
                        return null;
                    }
                }
            }
            return session;
        });
    }

    @Override
    public Future<Void> put(Session value) {
        LocalSession session = (LocalSession) value;
        synchronized (session) {
            if (session.destroyed) {
                return Future.succeededFuture();
            }
            // LocalSessionStore writes synchronously; destruction uses this same monitor.
            String storedId = session.raw.id();
            return delegate.put(session.raw).onSuccess(ignored -> {
                synchronized (session) {
                    if (storedId.equals(session.raw.id())) {
                        session.regenerated = false;
                        session.oldId = null;
                    }
                }
            });
        }
    }

    @Override public Future<Void> delete(String id) { return delegate.delete(id); }
    @Override public Future<Void> clear() { return delegate.clear(); }
    @Override public Future<Integer> size() { return delegate.size(); }
    @Override public void close() { delegate.close(); }

    public final class LocalSession implements Session {
        private final Session raw;
        private Subject subject;
        private boolean destroyed;
        private boolean regenerated;
        private String oldId;

        private LocalSession(Session raw) { this.raw = raw; }

        public synchronized boolean isBound() { return subject != null; }

        /** The caller holds this session's monitor through the check and any cache update. */
        public synchronized boolean bind(String issuer, String subjectId) {
            if (destroyed) {
                return false;
            }
            Subject requested = new Subject(issuer, subjectId);
            if (subject == null) {
                // Anonymous and legacy state, including a restored principal, is never adopted.
                synchronized (raw) {
                    raw.data().clear();
                    raw.put(WRAPPER, this);
                }
                subject = requested;
            }
            return subject.equals(requested);
        }

        public synchronized boolean belongsTo(String issuer, String subjectId) {
            return !destroyed && new Subject(issuer, subjectId).equals(subject);
        }

        @Override public synchronized Session regenerateId() {
            if (!destroyed) {
                if (!regenerated) { oldId = raw.id(); }
                raw.regenerateId();
                delegate.delete(oldId);
                regenerated = true;
            }
            return this;
        }
        @Override public synchronized String id() { return raw.id(); }
        @Override public synchronized Session put(String name, Object value) {
            if (!destroyed && !WRAPPER.equals(name)) { raw.put(name, value); }
            return this;
        }
        @Override public synchronized Session putIfAbsent(String name, Object value) {
            if (!destroyed && !WRAPPER.equals(name)) { raw.putIfAbsent(name, value); }
            return this;
        }
        @Override public synchronized Session computeIfAbsent(String name, Function<String, Object> function) {
            if (!destroyed && !WRAPPER.equals(name)) { raw.computeIfAbsent(name, function); }
            return this;
        }
        @Override public synchronized <T> T get(String name) {
            return destroyed || WRAPPER.equals(name) ? null : raw.get(name);
        }
        @Override public synchronized <T> T remove(String name) {
            return destroyed || WRAPPER.equals(name) ? null : raw.remove(name);
        }
        @Override public synchronized Map<String, Object> data() {
            if (destroyed) { return Map.of(); }
            Map<String, Object> copy = new HashMap<>(raw.data());
            copy.remove(WRAPPER);
            return Collections.unmodifiableMap(copy);
        }
        @Override public synchronized boolean isEmpty() { return data().isEmpty(); }
        @Override public synchronized long lastAccessed() { return raw.lastAccessed(); }
        @Override public synchronized long timeout() { return raw.timeout(); }
        @Override public synchronized boolean isDestroyed() { return destroyed; }
        @Override public synchronized boolean isRegenerated() { return regenerated; }
        @Override public synchronized String oldId() { return oldId; }
        @Override public synchronized void setAccessed() { if (!destroyed) { raw.setAccessed(); } }
        @Override public synchronized void destroy() {
            if (!destroyed) {
                destroyed = true;
                subject = null;
                raw.destroy();
                delegate.delete(raw.id());
                if (oldId != null) { delegate.delete(oldId); }
            }
        }
    }

    private record Subject(String issuer, String subject) {}
}
