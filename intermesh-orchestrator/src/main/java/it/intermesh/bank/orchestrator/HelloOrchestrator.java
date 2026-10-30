package it.intermesh.bank.orchestrator;

import org.eclipse.microprofile.config.inject.ConfigProperty;
import io.vertx.ext.web.RoutingContext;
import io.vertx.ext.web.Session;
import jakarta.ws.rs.DefaultValue;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.Context;
import jakarta.ws.rs.core.MediaType;

@Path("/hello")
public class HelloOrchestrator {

    @ConfigProperty(name = "NETWORK", defaultValue = "default-network")
    String networkName;

    @ConfigProperty(name = "HOSTNAME", defaultValue = "Local-Machine")
    String podName;

    @GET
    @Produces(MediaType.TEXT_PLAIN)
    public String helloDefault() {
        return hello();
    }

    @GET
    @Path("/session")
    @Produces(MediaType.TEXT_PLAIN)
    public String helloSession(@Context RoutingContext routingContext) {
        Session session = routingContext.session();

        String message = hello();

        String cookieHeader = routingContext.request().getHeader("Cookie");
        System.out.println("Cookie received: " + cookieHeader);

        synchronized (session) {
            if (session.isDestroyed()) {
                return message + "Session expired.";
            }
            if (session.get("initialized") == null) {
                message += "This is a new session with session id: " + session.id();
                session.put("initialized", true);
            } else {
                message += "This is an existing session with session id: " + session.id();
            }
        }

        return message;
    }

    private String hello() {
        return "Hello from " + podName + " in " + networkName + "!";
    }

    @GET
    @Path("/with-latency")
    @Produces(MediaType.TEXT_PLAIN)
    public String helloWithLatency(@QueryParam("seconds") @DefaultValue("1") int seconds) {
        try {
            Thread.sleep(seconds * 1000); // millis
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return hello();
    }

    @GET
    @Path("/{city}/{year}/user/{userId}/helloTo")
    @Produces(MediaType.TEXT_PLAIN)
    public String helloTo(@PathParam("city") String city,
                          @PathParam("year") int year,
                          @PathParam("userId") String userId,
                          @Context RoutingContext routingContext) {
        routingContext.request()
            .headers()
            .forEach(
                header 
                -> 
                System.out.println("Header: " + header.getKey() + " = " + header.getValue())
            );

        return "Hello from " + podName + " in " + networkName + " to user " + userId + " in " + city + " in year " + year + "!";
    }
}
