package it.intermesh.bank.orchestrator;

import static io.restassured.RestAssured.given;
import static org.junit.jupiter.api.Assertions.*;

import io.quarkus.test.common.QuarkusTestResource;
import io.quarkus.test.junit.QuarkusTest;
import io.restassured.http.ContentType;
import io.vertx.core.Vertx;
import io.vertx.ext.web.Session;
import io.vertx.ext.web.sstore.LocalSessionStore;
import it.intermesh.bank.security.JwtSecurityTestResource;
import jakarta.inject.Inject;
import java.net.URI;
import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.Test;

@QuarkusTest
@QuarkusTestResource(JwtSecurityTestResource.class)
class LegacySessionSecurityTest {
    @Inject Vertx vertx;
    URI fixtureUri;

    @Test
    void authenticatedRequestDiscardsLegacyFinancialAttributesAndRotatesTheCookie() {
        String oldId = given().get("/hello/session").then().statusCode(200).extract().cookie("JSESSIONID");
        var local = vertx.sharedData().<String, Session>getLocalMap(LocalSessionStore.DEFAULT_SESSION_MAP_NAME);
        Session legacy = local.get(oldId);
        assertNotNull(legacy);
        legacy.put("USER_ID", "user-b").put("ACCOUNT_ID", "legacy-account-b")
                .put("account_id", "legacy-account-b").put("IBAN", "LEGACY-IBAN")
                .put("iban", "LEGACY-IBAN").put("balance", -1);

        long now = Instant.now().getEpochSecond();
        String jwt = given().baseUri(fixtureUri.toString()).contentType(ContentType.JSON)
                .body(Map.of("iss", fixtureUri + "/realms/intermesh-bank", "sub", "subject-user-a",
                        "preferred_username", "user-a", "iat", now, "exp", now + 300))
                .post("/test/token").then().statusCode(200).extract().asString();
        String newId = given().cookie("JSESSIONID", oldId).header("Authorization", "Bearer " + jwt)
                .header("x-intermesh-user", "user-b").get("/api/v1/accounts/user-a")
                .then().statusCode(200).extract().cookie("JSESSIONID");

        assertNotNull(newId);
        assertNotEquals(oldId, newId);
        assertTrue(legacy.isDestroyed());
        assertNull(local.get(oldId));
        Session authenticated = local.get(newId);
        assertNotNull(authenticated);
        assertNull(authenticated.get("USER_ID"));
        assertNull(authenticated.get("ACCOUNT_ID"));
        assertNull(authenticated.get("IBAN"));
        assertNull(authenticated.get("initialized"));
        assertEquals("ACC-TEST", authenticated.get("account_id"));
        assertEquals("TEST-IBAN", authenticated.get("iban"));
    }
}
