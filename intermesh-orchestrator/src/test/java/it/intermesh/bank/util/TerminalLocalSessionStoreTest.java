package it.intermesh.bank.util;

import static org.junit.jupiter.api.Assertions.*;

import io.vertx.core.Future;
import io.vertx.core.Vertx;
import io.vertx.ext.web.Session;
import io.vertx.ext.web.sstore.LocalSessionStore;
import it.intermesh.bank.util.TerminalLocalSessionStore.LocalSession;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class TerminalLocalSessionStoreTest {
    private Vertx vertx;
    private TerminalLocalSessionStore store;

    @BeforeEach
    void start() {
        vertx = Vertx.vertx();
        store = new TerminalLocalSessionStore(LocalSessionStore.create(vertx, UUID.randomUUID().toString(), 0));
    }

    @AfterEach
    void stop() throws Exception {
        store.close();
        await(vertx.close());
    }

    private <T> T await(Future<T> future) throws Exception {
        return future.toCompletionStage().toCompletableFuture().get(3, TimeUnit.SECONDS);
    }

    private LocalSession fresh() {
        return (LocalSession) store.createSession(300_000);
    }

    @Test
    void anonymousAndLegacyDataAreDiscardedAndIdentifierRotated() throws Exception {
        LocalSession session = fresh();
        String oldId = session.id();
        session.put("initialized", true).put("account_id", "legacy-account").put("ACCOUNT_ID", "legacy-account")
                .put("USER_ID", "untrusted-owner").put("__vertx.userHolder", "legacy-principal");
        await(store.put(session));
        session.destroy();
        LocalSession authenticated = fresh();
        assertTrue(authenticated.bind("issuer-a", "subject-a"));
        assertNotEquals(oldId, authenticated.id());
        assertTrue(authenticated.data().isEmpty());
        assertTrue(session.data().isEmpty());
        assertNull(await(store.get(oldId)));
        await(store.put(authenticated));
        assertSame(authenticated, await(store.get(authenticated.id())));
        assertTrue(authenticated.belongsTo("issuer-a", "subject-a"));
        assertFalse(authenticated.bind("issuer-b", "subject-a"));
        // An older anonymous request cannot see or modify the authenticated object.
        session.put("ACCOUNT_ID", "late-anonymous-write");
        await(store.put(session));
        assertNull(authenticated.get("ACCOUNT_ID"));
        assertNull(await(store.get(oldId)));
    }

    @Test
    void destructionCannotBeReversedByAnyLateSessionAccessOrStoreFlush() throws Exception {
        LocalSession session = fresh();
        session.bind("issuer", "subject-a");
        session.put("account_id", "account-a");
        await(store.put(session));
        String retired = session.id();
        Session sameReference = await(store.get(retired));
        session.destroy();
        assertNull(await(store.get(retired)));
        sameReference.put("account_id", "late-account").putIfAbsent("balance", 100)
                .computeIfAbsent("iban", ignored -> fail("Destroyed sessions must not evaluate writes"));
        sameReference.regenerateId();
        sameReference.setAccessed();
        assertNull(sameReference.get("account_id"));
        assertNull(sameReference.remove("account_id"));
        assertTrue(sameReference.data().isEmpty());
        assertFalse(session.bind("issuer", "subject-b"));
        await(store.put(sameReference));
        assertTrue(sameReference.isDestroyed());
        assertEquals(retired, sameReference.id());
        assertNull(await(store.get(retired)));
    }

    @Test
    void concurrentInvalidationPreventsAnAlreadyRunningOperationFromWritingBack() throws Exception {
        LocalSession session = fresh();
        session.bind("issuer", "subject-a");
        await(store.put(session));
        String retired = session.id();
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch finish = new CountDownLatch(1);
        CompletableFuture<Void> pending = CompletableFuture.runAsync(() -> {
            synchronized (session) {
                assertTrue(session.belongsTo("issuer", "subject-a"));
            }
            entered.countDown();
            try {
                assertTrue(finish.await(3, TimeUnit.SECONDS));
                synchronized (session) {
                    assertFalse(session.belongsTo("issuer", "subject-a"));
                    session.put("account_id", "late-account");
                }
                await(store.put(session));
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        });
        assertTrue(entered.await(3, TimeUnit.SECONDS));
        synchronized (session) {
            assertFalse(session.bind("issuer", "subject-b"));
            session.destroy();
        }
        finish.countDown();
        pending.get(3, TimeUnit.SECONDS);
        assertTrue(session.data().isEmpty());
        assertNull(await(store.get(retired)));
    }

    @Test
    void expiredAndUnknownIdentifiersDoNotResolveToUsableSessions() throws Exception {
        LocalSession session = (LocalSession) store.createSession(1);
        String id = session.id();
        await(store.put(session));
        Thread.sleep(10);
        assertNull(await(store.get(id)));
        assertTrue(session.isDestroyed());
        assertNull(await(store.get("unknown")));
    }

    @Test
    void anotherPodHasNoBindingForAnUnknownIdentifier() throws Exception {
        LocalSession alice = fresh();
        alice.bind("issuer", "subject-a");
        await(store.put(alice));
        var otherStore = new TerminalLocalSessionStore(LocalSessionStore.create(vertx, UUID.randomUUID().toString(), 0));
        try {
            assertNull(await(otherStore.get(alice.id())));
            LocalSession bob = (LocalSession) otherStore.createSession(300_000);
            assertTrue(bob.bind("issuer", "subject-b"));
            assertNotEquals(alice.id(), bob.id());
            assertTrue(alice.belongsTo("issuer", "subject-a"));
        } finally {
            otherStore.close();
        }
    }
}
