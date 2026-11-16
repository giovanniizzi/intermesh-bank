package it.intermesh.bank.security;

import io.smallrye.jwt.auth.principal.JWTParser;
import io.smallrye.jwt.auth.principal.ParseException;
import io.vertx.ext.web.RoutingContext;
import jakarta.enterprise.context.RequestScoped;
import jakarta.inject.Inject;
import jakarta.ws.rs.NotAuthorizedException;
import java.util.List;
import org.eclipse.microprofile.jwt.JsonWebToken;

@RequestScoped
public class BankingIdentityProvider {

    @Inject
    JWTParser jwtParser;

    @Inject
    RoutingContext routingContext;

    public BankingIdentity requireIdentity() {
        List<String> authorization = routingContext.request().headers().getAll("Authorization");
        if (authorization.size() != 1
                || !authorization.get(0).regionMatches(true, 0, "Bearer ", 0, 7)) {
            throw new NotAuthorizedException("Bearer");
        }

        try {
            // Verify this request's bearer, independently of any principal restored by the session handler.
            JsonWebToken token = jwtParser.parse(authorization.get(0).substring(7));
            return new BankingIdentity(
                    requireString(token, "iss"),
                    requireString(token, "sub"),
                    requireString(token, "preferred_username"));
        } catch (ParseException e) {
            throw new NotAuthorizedException("Bearer");
        }
    }

    private String requireString(JsonWebToken token, String name) {
        Object claim = token.getClaim(name);
        if (claim instanceof String value && !value.isBlank()) {
            return value;
        }
        throw new NotAuthorizedException("Bearer");
    }
}
