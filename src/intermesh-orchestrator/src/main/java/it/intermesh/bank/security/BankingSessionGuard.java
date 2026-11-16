package it.intermesh.bank.security;

import io.vertx.ext.web.RoutingContext;
import io.vertx.ext.web.Session;
import it.intermesh.bank.util.TerminalLocalSessionStore.LocalSession;
import it.intermesh.bank.util.VertxSessionConfig;
import jakarta.enterprise.context.RequestScoped;
import jakarta.inject.Inject;
import jakarta.ws.rs.ForbiddenException;
import jakarta.ws.rs.core.Response;
import java.util.Map;
import java.util.function.Function;

@RequestScoped
public class BankingSessionGuard {
    @Inject BankingIdentityProvider identityProvider;
    @Inject RoutingContext routingContext;
    @Inject VertxSessionConfig sessionConfig;

    private BankingIdentity identity;
    private LocalSession session;

    public BankingIdentity requireIdentity() {
        BankingIdentity verified = identityProvider.requireIdentity();
        if (!(routingContext.session() instanceof LocalSession resolved)) {
            throw new IllegalStateException("Banking session handler is required");
        }
        synchronized (resolved) {
            if (resolved.isDestroyed()) {
                sessionConfig.invalidate(routingContext, resolved);
                throw denied();
            }
            if (!resolved.isBound()) {
                resolved.destroy();
                // A separate object keeps earlier anonymous requests attached to terminal state.
                session = sessionConfig.newSession(routingContext);
                session.bind(verified.issuer(), verified.subject());
            } else if (!resolved.belongsTo(verified.issuer(), verified.subject())) {
                sessionConfig.invalidate(routingContext, resolved);
                throw denied();
            } else {
                session = resolved;
            }
            // A restored framework principal is never used as the banking identity.
            routingContext.clearUser();
            identity = verified;
        }
        return verified;
    }

    /** No remote calls belong in this short, local critical section. */
    public <T> T withSession(Function<Session, T> update) {
        synchronized (session) {
            if (!session.belongsTo(identity.issuer(), identity.subject())) {
                sessionConfig.invalidate(routingContext, session);
                throw denied();
            }
            return update.apply(session);
        }
    }

    private ForbiddenException denied() {
        return new ForbiddenException(Response.status(Response.Status.FORBIDDEN)
                .entity(Map.of("error", "Access denied")).build());
    }
}
