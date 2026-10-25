package it.intermesh.bank.util;

import org.eclipse.microprofile.config.ConfigProvider;
import io.vertx.core.Vertx;
import io.vertx.ext.web.handler.SessionHandler;
import io.vertx.ext.web.sstore.LocalSessionStore;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;
import io.vertx.ext.web.Router;
import jakarta.inject.Inject;

@ApplicationScoped
public class VertxSessionConfig {

    @Inject
    Vertx vertx;

    public void setupRouter(@Observes Router router) {
        String cookieName = ConfigProvider.getConfig()
                .getOptionalValue("quarkus.http.session.cookie-name", String.class)
                .orElse("JSESSIONID");
        
        String timeout = ConfigProvider.getConfig()
                .getOptionalValue("quarkus.http.session.timeout", String.class)
                .orElse("5m");       

        SessionHandler sessionHandler = SessionHandler.create(LocalSessionStore.create(vertx))
                .setSessionCookieName(cookieName)
                .setSessionTimeout(Long.parseLong(timeout.split("m")[0]) * 60 * 1000) // millis
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
        });

        // router.route().handler(sessionHandler);
    }
}
