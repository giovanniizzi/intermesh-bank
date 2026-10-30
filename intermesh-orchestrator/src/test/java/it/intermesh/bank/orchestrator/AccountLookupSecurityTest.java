package it.intermesh.bank.orchestrator;

import static io.restassured.RestAssured.given;
import static io.restassured.config.LogConfig.logConfig;
import static org.hamcrest.Matchers.is;
import static org.hamcrest.Matchers.greaterThan;
import static org.hamcrest.Matchers.startsWith;

import io.quarkus.test.common.QuarkusTestResource;
import io.quarkus.test.junit.QuarkusTest;
import io.restassured.http.ContentType;
import io.restassured.RestAssured;
import it.intermesh.bank.security.JwtSecurityTestResource;
import java.net.URI;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

@QuarkusTest
@QuarkusTestResource(JwtSecurityTestResource.class)
public class AccountLookupSecurityTest {

    URI fixtureUri;

    @BeforeEach
    void resetLedgerCalls() {
        RestAssured.config = RestAssured.config.logConfig(
                logConfig().blacklistHeader("Authorization", "Cookie", "Set-Cookie"));
        given().baseUri(fixtureUri.toString()).post("/test/reset").then().statusCode(204);
    }

    private Map<String, Object> claims(String owner) {
        long now = Instant.now().getEpochSecond();
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("iss", fixtureUri + "/realms/intermesh-bank");
        claims.put("sub", "subject-" + owner);
        claims.put("preferred_username", owner);
        claims.put("iat", now);
        claims.put("exp", now + 300);
        return claims;
    }

    private String token(Map<String, Object> claims) {
        return token(claims, "/test/token");
    }

    private String token(Map<String, Object> claims, String path) {
        return given().baseUri(fixtureUri.toString()).contentType(ContentType.JSON)
                .body(claims).post(path).then().statusCode(200).extract().asString();
    }

    private void assertLedgerCalls(int count, String owner) {
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .statusCode(200).body("count", is(count)).body("owner", is(owner));
    }

    private void assertUnauthorized(Map<String, Object> claims) {
        given().header("Authorization", "Bearer " + token(claims))
                .get("/api/v1/accounts/user-a").then()
                .statusCode(401).header("WWW-Authenticate", startsWith("Bearer"));
        assertLedgerCalls(0, "");
    }

    @Test
    void sameUserReceivesExistingAccountContract() {
        given().header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/accounts/user-a").then().statusCode(200)
                .body("account_id", is("ACC-TEST"))
                .body("user_id", is("user-a"))
                .body("iban", is("TEST-IBAN"))
                .body("holder_name", is("Test Account"))
                .body("balance", is(100.0f))
                .body("frozen_balance", is(0.0f));
        assertLedgerCalls(1, "user-a");
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .statusCode(200).body("jwksCalls", greaterThan(0));
    }

    @Test
    void crossUserLookupIsForbiddenBeforeLedger() {
        given().header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/accounts/user-b").then().statusCode(403)
                .body("error", is("Access denied"));
        assertLedgerCalls(0, "");
    }

    @Test
    void usernameComparisonIsCaseSensitive() {
        given().header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/accounts/User-A").then().statusCode(403);
        assertLedgerCalls(0, "");
    }

    @Test
    void ownerKeyIsNotTrimmed() {
        given().header("Authorization", "Bearer " + token(claims(" user-a ")))
                .get("/api/v1/accounts/user-a").then().statusCode(403);
        assertLedgerCalls(0, "");
    }

    @Test
    void missingTokenIsUnauthorized() {
        given().get("/api/v1/accounts/user-a").then()
                .statusCode(401).header("WWW-Authenticate", startsWith("Bearer"));
        assertLedgerCalls(0, "");
    }

    @Test
    void malformedTokenIsUnauthorized() {
        given().header("Authorization", "Bearer not-a-jwt")
                .get("/api/v1/accounts/user-a").then().statusCode(401);
        assertLedgerCalls(0, "");
    }

    @Test
    void wrongSignatureWithKnownKeyIdIsUnauthorized() {
        given().header("Authorization", "Bearer " + token(claims("user-a"), "/test/token/invalid-signature"))
                .get("/api/v1/accounts/user-a").then().statusCode(401);
        assertLedgerCalls(0, "");
    }

    @Test
    void wrongIssuerIsUnauthorized() {
        Map<String, Object> claims = claims("user-a");
        claims.put("iss", "https://other-issuer.example.invalid/realms/intermesh-bank");
        assertUnauthorized(claims);
    }

    @Test
    void expiredTokenIsUnauthorized() {
        Map<String, Object> claims = claims("user-a");
        claims.put("iat", Instant.now().minusSeconds(600).getEpochSecond());
        claims.put("exp", Instant.now().minusSeconds(300).getEpochSecond());
        assertUnauthorized(claims);
    }

    @Test
    void missingExpirationIsUnauthorized() {
        Map<String, Object> claims = claims("user-a");
        claims.remove("exp");
        assertUnauthorized(claims);
    }

    @Test
    void tokenNotYetValidIsUnauthorized() {
        Map<String, Object> claims = claims("user-a");
        claims.put("nbf", Instant.now().plusSeconds(180).getEpochSecond());
        assertUnauthorized(claims);
    }

    @Test
    void missingIdentityClaimsAreUnauthorized() {
        for (String name : List.of("iss", "sub", "preferred_username")) {
            Map<String, Object> claims = claims("user-a");
            claims.remove(name);
            assertUnauthorized(claims);
        }
    }

    @Test
    void nullIdentityClaimsAreUnauthorized() {
        for (String name : List.of("iss", "sub", "preferred_username")) {
            Map<String, Object> claims = claims("user-a");
            claims.put(name, null);
            assertUnauthorized(claims);
        }
    }

    @Test
    void blankIdentityClaimsAreUnauthorized() {
        for (String name : List.of("iss", "sub", "preferred_username")) {
            for (String value : List.of("", " ", "\t\n")) {
                Map<String, Object> claims = claims("user-a");
                claims.put(name, value);
                assertUnauthorized(claims);
            }
        }
    }

    @Test
    void incorrectlyTypedIdentityClaimsAreUnauthorized() {
        for (String name : List.of("iss", "sub", "preferred_username")) {
            for (Object value : List.of(42, true, List.of("user-a"), Map.of("value", "user-a"))) {
                Map<String, Object> claims = claims("user-a");
                claims.put(name, value);
                assertUnauthorized(claims);
            }
        }
    }

    @Test
    void forgedHeaderCannotAuthorizeAnotherUser() {
        given().header("Authorization", "Bearer " + token(claims("user-a")))
                .header("x-intermesh-user", "user-b")
                .get("/api/v1/accounts/user-b").then().statusCode(403);
        assertLedgerCalls(0, "");
    }

    @Test
    void forgedHeaderCannotReplaceVerifiedOwner() {
        given().header("Authorization", "Bearer " + token(claims("user-a")))
                .header("x-intermesh-user", "user-b")
                .get("/api/v1/accounts/user-a").then().statusCode(200).body("user_id", is("user-a"));
        assertLedgerCalls(1, "user-a");
    }

    @Test
    void identityHeaderWithoutTokenIsUnauthorized() {
        given().header("x-intermesh-user", "user-a")
                .get("/api/v1/accounts/user-a").then().statusCode(401);
        assertLedgerCalls(0, "");
    }

    @Test
    void missingOwnAccountPreservesNotFoundContract() {
        given().header("Authorization", "Bearer " + token(claims("missing-user")))
                .get("/api/v1/accounts/missing-user").then().statusCode(404)
                .body("error", is("No active asset provisioned for the requested user profile"));
        assertLedgerCalls(1, "missing-user");
    }

    @Test
    void sessionAccountCannotAuthorizeAnotherSubject() {
        String session = given().header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/accounts/user-a").then().statusCode(200).extract().cookie("JSESSIONID");
        resetLedgerCalls();
        given().cookie("JSESSIONID", session)
                .header("Authorization", "Bearer " + token(claims("user-b")))
                .get("/api/v1/accounts/user-a").then().statusCode(403);
        assertLedgerCalls(0, "");
    }

    @Test
    void differentSubjectCanAccessOwnAccountWithAnExistingSession() {
        String session = given().header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/accounts/user-a").then().statusCode(200).extract().cookie("JSESSIONID");
        resetLedgerCalls();
        given().cookie("JSESSIONID", session)
                .header("Authorization", "Bearer " + token(claims("user-b")))
                .get("/api/v1/accounts/user-b").then().statusCode(200).body("user_id", is("user-b"));
        assertLedgerCalls(1, "user-b");
    }

    @Test
    void existingSessionCannotReplaceMissingBearerToken() {
        String session = given().header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/accounts/user-a").then().statusCode(200).extract().cookie("JSESSIONID");
        resetLedgerCalls();
        given().cookie("JSESSIONID", session).get("/api/v1/accounts/user-a").then().statusCode(401);
        assertLedgerCalls(0, "");
    }

    @Test
    void diagnosticWithoutTokenRemainsAccessibleToApplicationTests() {
        given().get("/hello").then().statusCode(200);
        assertLedgerCalls(0, "");
    }

    @Test
    void diagnosticWithInvalidTokenIsRejectedByProactiveAuthentication() {
        given().header("Authorization", "Bearer not-a-jwt").get("/hello").then().statusCode(401);
        assertLedgerCalls(0, "");
    }
}
