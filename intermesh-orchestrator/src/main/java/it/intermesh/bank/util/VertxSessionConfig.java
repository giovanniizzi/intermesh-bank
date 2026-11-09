package it.intermesh.bank.util;

import org.eclipse.microprofile.config.ConfigProvider;
import io.quarkus.arc.ClientProxy;
import io.vertx.core.Vertx;
import io.vertx.ext.web.handler.SessionHandler;
import io.vertx.ext.web.sstore.LocalSessionStore;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;
import io.vertx.ext.web.Router;
import jakarta.inject.Inject;
import java.time.Duration;

@ApplicationScoped
public class VertxSessionConfig {

    private SessionHandler sessionHandler;

    @Inject
    Vertx vertx;

    public void setupRouter(@Observes Router router) {
        String cookieName = ConfigProvider.getConfig()
                .getOptionalValue("quarkus.http.session.cookie-name", String.class)
                .orElse("JSESSIONID");
        
        Duration timeout = ConfigProvider.getConfig()
                .getOptionalValue("quarkus.http.session.timeout", Duration.class)
                .orElse(Duration.ofMinutes(5));

        sessionHandler = SessionHandler.create(
                new TerminalLocalSessionStore(LocalSessionStore.create(vertx)))
                .setSessionCookieName(cookieName)
                .setSessionTimeout(timeout.toMillis())
                .setCookieMaxAge(-1); 
        
        router.route().handler(rc -> {
            String path = rc.normalizedPath();
            
            // Bypass session allocation if the target matching path belongs to health monitoring domains
            if (path.equals("/healthz") || path.startsWith("/q/health")) {
                rc.next(); // Forward directly to the endpoint without mounting the JSESSIONID context
            } else {
                // Safely delegate execution flow to the standard stateful handler configuration
                sessionHandler.handle(rc);
            }
        }).handler(rc -> {
            // Discard the session-restored user; Quarkus retains this request's deferred authentication.
            rc.clearUser();
            rc.next();
        });

        // router.route().handler(sessionHandler);
    }

    public TerminalLocalSessionStore.LocalSession newSession(io.vertx.ext.web.RoutingContext context) {
        context = ClientProxy.unwrap(context);
        context.clearUser();
        return (TerminalLocalSessionStore.LocalSession) sessionHandler.newSession(context);
    }

    public void invalidate(io.vertx.ext.web.RoutingContext context,
                           TerminalLocalSessionStore.LocalSession session) {
        context = ClientProxy.unwrap(context);
        session.destroy();
        context.clearUser();
        // newSession() may already have flushed this response; explicitly expire its cookie too.
        sessionHandler.flush(context);
    }
}
