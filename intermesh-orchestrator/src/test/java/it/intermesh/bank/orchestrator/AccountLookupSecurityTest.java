package it.intermesh.bank.orchestrator;

import static io.restassured.RestAssured.given;
import static io.restassured.config.LogConfig.logConfig;
import static org.hamcrest.Matchers.is;
import static org.hamcrest.Matchers.greaterThan;
import static org.hamcrest.Matchers.startsWith;
import static org.junit.jupiter.api.Assertions.*;

import io.quarkus.test.common.QuarkusTestResource;
import io.quarkus.test.junit.QuarkusTest;
import io.restassured.http.ContentType;
import io.restassured.RestAssured;
import it.intermesh.bank.security.JwtSecurityTestResource;
import it.intermesh.bank.validation.MonetaryAmountsTest;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.DeserializationFeature;
import java.math.BigDecimal;
import java.net.URI;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import io.restassured.response.Response;
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
    void differentSubjectCannotReuseAnExistingSession() {
        String session = given().header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/accounts/user-a").then().statusCode(200).extract().cookie("JSESSIONID");
        resetLedgerCalls();
        given().cookie("JSESSIONID", session)
                .header("Authorization", "Bearer " + token(claims("user-b")))
                .get("/api/v1/accounts/user-b").then().statusCode(403);
        assertLedgerCalls(0, "");
    }

    @Test
    void existingSessionCannotReplaceMissingBearerToken() {
        String session = given().header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/accounts/user-a").then().statusCode(200).extract().cookie("JSESSIONID");
        resetLedgerCalls();
        given().cookie("JSESSIONID", session).get("/api/v1/accounts/user-a").then().statusCode(401);
        assertLedgerCalls(0, "");
    }

    private String aliceSession() {
        String id = given().header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/accounts/user-a").then().statusCode(200).extract().cookie("JSESSIONID");
        assertNotNull(id);
        resetLedgerCalls();
        return id;
    }

    private void noDownstreamCalls() {
        assertLedgerCalls(0, "");
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .body("fraudCalls", is(0));
    }

    private void expiredSessionCookie(Response response) {
        var cookie = response.getDetailedCookie("JSESSIONID");
        assertNotNull(cookie);
        assertEquals(0, cookie.getMaxAge());
        assertEquals("/", cookie.getPath());
        assertFalse(cookie.isSecured());
        assertFalse(cookie.isHttpOnly()); // Preserve the attributes of the existing custom handler.
        assertNull(response.getCookie("network1.session"));
        assertNull(response.getCookie("network2.session"));
        assertNull(response.getHeader("Location"));
    }

    @Test
    void sameSubjectRetainsSessionAndCrossAccountDenialDoesNotDestroyIt() {
        String session = aliceSession();
        String jwt = token(claims("user-a"));
        given().cookie("JSESSIONID", session).header("Authorization", "Bearer " + jwt)
                .get("/api/v1/accounts/user-b").then().statusCode(403);
        noDownstreamCalls();
        Response response = given().cookie("JSESSIONID", session).header("Authorization", "Bearer " + jwt)
                .get("/api/v1/accounts/user-a");
        response.then().statusCode(200);
        assertNull(response.getCookie("JSESSIONID"));
        given().cookie("JSESSIONID", session).get("/hello/session").then().statusCode(200)
                .body(org.hamcrest.Matchers.containsString(session));
    }

    @Test
    void mismatchExpiresCookieAndBobRetriesWithoutKeycloakReauthentication() {
        for (String requested : List.of("user-a", "user-b")) {
            String retired = aliceSession();
            String bobJwt = token(claims("user-b"));
            Response denied = given().cookie("JSESSIONID", retired).header("Authorization", "Bearer " + bobJwt)
                    .get("/api/v1/accounts/" + requested);
            denied.then().statusCode(403).body("error", is("Access denied"));
            expiredSessionCookie(denied);
            noDownstreamCalls();
            Response retry = given().header("Authorization", "Bearer " + bobJwt)
                    .get("/api/v1/accounts/user-b");
            retry.then().statusCode(200).body("user_id", is("user-b"));
            assertNotEquals(retired, retry.getCookie("JSESSIONID"));
            // Even an explicit replay of the old identifier is a lookup miss, never Alice's state.
            Response replay = given().cookie("JSESSIONID", retired).header("Authorization", "Bearer " + bobJwt)
                    .get("/api/v1/accounts/user-b");
            replay.then().statusCode(200);
            assertNotNull(replay.getCookie("JSESSIONID"));
            assertNotEquals(retired, replay.getCookie("JSESSIONID"));
        }
    }

    @Test
    void invalidBearerCannotUseAnExistingSession() {
        String session = aliceSession();
        Map<String, Object> unusable = claims("user-a");
        unusable.remove("preferred_username");
        Map<String, Object> expired = claims("user-a");
        expired.put("exp", Instant.now().minusSeconds(300).getEpochSecond());
        for (String jwt : List.of("not-a-jwt", token(claims("user-b"), "/test/token/invalid-signature"),
                token(unusable), token(expired))) {
            given().cookie("JSESSIONID", session).header("Authorization", "Bearer " + jwt)
                    .get("/api/v1/accounts/user-a").then().statusCode(401);
            noDownstreamCalls();
        }
    }

    @Test
    void refreshedJwtForSameSubjectPreservesSession() {
        String session = aliceSession();
        Map<String, Object> refreshed = claims("user-a");
        refreshed.put("jti", "synthetic-refreshed-token");
        Response response = given().cookie("JSESSIONID", session)
                .header("Authorization", "Bearer " + token(refreshed)).get("/api/v1/accounts/user-a");
        response.then().statusCode(200);
        assertNull(response.getCookie("JSESSIONID"));
    }

    @Test
    void bindingUsesSubjectRatherThanUsername() {
        String session = aliceSession();
        Map<String, Object> changedSubject = claims("user-a");
        changedSubject.put("sub", "different-subject-with-same-username");
        Response response = given().cookie("JSESSIONID", session)
                .header("Authorization", "Bearer " + token(changedSubject)).get("/api/v1/accounts/user-a");
        response.then().statusCode(403);
        expiredSessionCookie(response);
        noDownstreamCalls();
    }

    @Test
    void anonymousSessionIsClearedAndRotatedBeforeBinding() {
        Response anonymous = given().get("/hello/session");
        anonymous.then().statusCode(200);
        String oldId = anonymous.getCookie("JSESSIONID");
        Response authenticated = given().cookie("JSESSIONID", oldId)
                .header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/accounts/user-a");
        authenticated.then().statusCode(200);
        String newId = authenticated.getCookie("JSESSIONID");
        assertNotNull(newId);
        assertNotEquals(oldId, newId);
        given().cookie("JSESSIONID", newId).get("/hello/session").then().statusCode(200)
                .body(org.hamcrest.Matchers.containsString("This is a new session"));
    }

    @Test
    void unknownSessionIdInitializesFreshLocalState() {
        String unknown = "0123456789abcdef0123456789abcdef";
        Response response = given().cookie("JSESSIONID", unknown)
                .header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/accounts/user-a");
        response.then().statusCode(200);
        assertNotNull(response.getCookie("JSESSIONID"));
        assertNotEquals(unknown, response.getCookie("JSESSIONID"));
    }

    @Test
    void expiredLocalSessionCanInitializeForAnotherSubject() throws InterruptedException {
        String expired = aliceSession();
        Thread.sleep(11_000); // The HTTP fixture sets the application session timeout to ten seconds.
        Response response = given().cookie("JSESSIONID", expired)
                .header("Authorization", "Bearer " + token(claims("user-b")))
                .get("/api/v1/accounts/user-b");
        response.then().statusCode(200);
        assertNotNull(response.getCookie("JSESSIONID"));
        assertNotEquals(expired, response.getCookie("JSESSIONID"));
    }

    @Test
    void everyBankingEndpointRejectsMismatchedSessionsBeforeAnyDownstreamCall() {
        for (String endpoint : List.of("/api/v1/accounts", "/api/v1/account/ACC-TEST/transactions", "/api/v1/transfers")) {
            String session = aliceSession();
            var request = given().cookie("JSESSIONID", session)
                    .header("Authorization", "Bearer " + token(claims("user-b")))
                    .header("x-intermesh-user", "user-a").contentType(ContentType.JSON);
            Response response;
            if (endpoint.endsWith("transactions")) {
                response = request.get(endpoint);
            } else {
                response = request.body(endpoint.endsWith("transfers")
                        ? Map.of("transfer_request_id", UUID.randomUUID().toString(), "source_account", "ACC-TEST", "target_account", "ACC-OTHER", "amount", 1)
                        : Map.of("holder_name", "Test Account", "initial_deposit", 100)).post(endpoint);
            }
            response.then().statusCode(403);
            expiredSessionCookie(response);
            noDownstreamCalls();
        }
    }

    @Test
    void allBankingEndpointsRequireCurrentBearerWithExistingSession() {
        String session = aliceSession();
        given().cookie("JSESSIONID", session).contentType(ContentType.JSON).body("{}")
                .post("/api/v1/accounts").then().statusCode(401);
        given().cookie("JSESSIONID", session).get("/api/v1/account/ACC-TEST/transactions")
                .then().statusCode(401);
        given().cookie("JSESSIONID", session).contentType(ContentType.JSON).body("{}")
                .post("/api/v1/transfers").then().statusCode(401);
        noDownstreamCalls();
    }

    @Test
    void sameSubjectCanCreateReadHistoryAndTransferWithExistingContracts() {
        String session = aliceSession();
        String jwt = token(claims("user-a"));
        given().cookie("JSESSIONID", session).header("Authorization", "Bearer " + jwt)
                .header("x-intermesh-user", "user-b").contentType(ContentType.JSON)
                .body(Map.of("holder_name", "Test Account", "initial_deposit", 100))
                .post("/api/v1/accounts").then().statusCode(201)
                .body("session_token", is(session)).body("account_details.user_id", is("user-a"));
        given().cookie("JSESSIONID", session).header("Authorization", "Bearer " + jwt)
                .get("/api/v1/account/ACC-TEST/transactions").then().statusCode(200);
        given().cookie("JSESSIONID", session).header("Authorization", "Bearer " + jwt)
                .contentType(ContentType.JSON)
                .body(Map.of("transfer_request_id", UUID.randomUUID().toString(), "source_account", "ACC-TEST", "target_account", "ACC-OTHER", "amount", 1))
                .post("/api/v1/transfers").then().statusCode(200);
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .body("count", is(6)).body("fraudCalls", is(1));
    }

    @Test
    void inFlightLookupCannotRestoreStateAfterConcurrentMismatch() throws Exception {
        String retired = aliceSession();
        String aliceJwt = token(claims("user-a"));
        String bobJwt = token(claims("user-b"));
        given().baseUri(fixtureUri.toString()).post("/test/block").then().statusCode(200);
        CompletableFuture<Response> inFlight = CompletableFuture.supplyAsync(() ->
                given().cookie("JSESSIONID", retired).header("Authorization", "Bearer " + aliceJwt)
                        .get("/api/v1/accounts/user-a"));
        try {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            boolean blocked = false;
            while (System.nanoTime() < deadline) {
                blocked = given().baseUri(fixtureUri.toString()).get("/test/ledger-calls")
                        .jsonPath().getBoolean("blocked");
                if (blocked) { break; }
                Thread.sleep(20);
            }
            assertTrue(blocked, "Lookup must reach the controlled downstream barrier");
            Response denied = given().cookie("JSESSIONID", retired).header("Authorization", "Bearer " + bobJwt)
                    .get("/api/v1/accounts/user-b");
            denied.then().statusCode(403);
            expiredSessionCookie(denied);
            assertLedgerCalls(1, "user-a");
        } finally {
            given().baseUri(fixtureUri.toString()).post("/test/release").then().statusCode(200);
        }
        Response late = inFlight.get(5, TimeUnit.SECONDS);
        late.then().statusCode(403);
        expiredSessionCookie(late);
        Response retry = given().cookie("JSESSIONID", retired).header("Authorization", "Bearer " + bobJwt)
                .get("/api/v1/accounts/user-b");
        retry.then().statusCode(200);
        assertNotEquals(retired, retry.getCookie("JSESSIONID"));
    }

    @Test
    void concurrentRequestsFromSameSubjectCanShareSessionWithoutLockingRemoteCalls() throws Exception {
        String session = aliceSession();
        String jwt = token(claims("user-a"));
        given().baseUri(fixtureUri.toString()).post("/test/block").then().statusCode(200);
        CompletableFuture<Response> inFlight = CompletableFuture.supplyAsync(() ->
                given().cookie("JSESSIONID", session).header("Authorization", "Bearer " + jwt)
                        .get("/api/v1/accounts/user-a"));
        try {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            boolean blocked = false;
            while (System.nanoTime() < deadline) {
                blocked = given().baseUri(fixtureUri.toString()).get("/test/ledger-calls")
                        .jsonPath().getBoolean("blocked");
                if (blocked) { break; }
                Thread.sleep(20);
            }
            assertTrue(blocked);
            given().cookie("JSESSIONID", session).header("Authorization", "Bearer " + jwt)
                    .get("/api/v1/accounts/user-a").then().statusCode(200);
            assertLedgerCalls(2, "user-a");
        } finally {
            given().baseUri(fixtureUri.toString()).post("/test/release").then().statusCode(200);
        }
        Response completed = inFlight.get(5, TimeUnit.SECONDS);
        completed.then().statusCode(200);
        assertNull(completed.getCookie("JSESSIONID"));
    }

    private void assertHistoryCalls(int lookups, int histories) {
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then().statusCode(200)
                .body("accountLookups", is(lookups)).body("historyCalls", is(histories))
                .body("count", is(lookups + histories)).body("fraudCalls", is(0));
    }

    @Test
    void ownedTransactionHistoryPreservesResponseFields() {
        String session = aliceSession();
        given().cookie("JSESSIONID", session).header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/account/ACC-ALICE/transactions").then().statusCode(200)
                .body("size()", is(1))
                .body("[0].transaction_id", is("TX-ACC-ALICE"))
                .body("[0].target_iban", is("TEST-TARGET-IBAN"))
                .body("[0].amount", is(12.5f))
                .body("[0].status", is("COMMITTED"))
                .body("[0].timestamp", is("2026-01-01 12:00:00+00"));
        assertHistoryCalls(1, 1);
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .body("lookupAccount", is("ACC-ALICE")).body("historyAccount", is("ACC-ALICE"));
    }

    @Test
    void anotherOwnersTransactionHistoryIsForbiddenBeforeHistoryFetch() {
        String session = aliceSession();
        Response denied = given().cookie("JSESSIONID", session)
                .header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/account/ACC-BOB/transactions");
        denied.then().statusCode(403).body("error", is("Access denied")).body("size()", is(1));
        assertNull(denied.getCookie("JSESSIONID"));
        assertHistoryCalls(1, 0);
    }

    @Test
    void unknownHistoryAccountReturnsSanitizedNotFound() {
        given().header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/account/ACC-MISSING/transactions").then().statusCode(404)
                .body("error", is("Account not found")).body("size()", is(1));
        assertHistoryCalls(1, 0);
    }

    @Test
    void historyWithoutBearerIsUnauthorizedBeforeAnyLedgerCall() {
        given().get("/api/v1/account/ACC-ALICE/transactions").then().statusCode(401);
        assertHistoryCalls(0, 0);
    }

    @Test
    void historyWithInvalidBearerAndExistingSessionIsUnauthorized() {
        String session = aliceSession();
        Map<String, Object> expired = claims("user-a");
        expired.put("exp", Instant.now().minusSeconds(300).getEpochSecond());
        Map<String, Object> missingOwner = claims("user-a");
        missingOwner.remove("preferred_username");
        for (String jwt : List.of("not-a-jwt", token(claims("user-a"), "/test/token/invalid-signature"),
                token(expired), token(missingOwner))) {
            given().cookie("JSESSIONID", session).header("Authorization", "Bearer " + jwt)
                    .get("/api/v1/account/ACC-ALICE/transactions").then().statusCode(401);
            assertHistoryCalls(0, 0);
        }
    }

    @Test
    void historySessionMismatchInvalidatesBeforeAccountLookupAndAllowsFreshRetry() {
        String retired = aliceSession();
        String bobJwt = token(claims("user-b"));
        Response denied = given().cookie("JSESSIONID", retired).header("Authorization", "Bearer " + bobJwt)
                .get("/api/v1/account/ACC-BOB/transactions");
        denied.then().statusCode(403).body("error", is("Access denied"));
        expiredSessionCookie(denied);
        assertHistoryCalls(0, 0);
        given().header("Authorization", "Bearer " + bobJwt)
                .get("/api/v1/account/ACC-BOB/transactions").then().statusCode(200)
                .body("[0].transaction_id", is("TX-ACC-BOB"));
        assertHistoryCalls(1, 1);
    }

    @Test
    void forgedIdentityHeaderCannotAuthorizeAnotherOwnersHistory() {
        given().header("Authorization", "Bearer " + token(claims("user-a")))
                .header("x-intermesh-user", "user-b").get("/api/v1/account/ACC-BOB/transactions")
                .then().statusCode(403).body("error", is("Access denied"));
        assertHistoryCalls(1, 0);
    }

    @Test
    void forgedIdentityHeaderDoesNotReplaceVerifiedHistoryOwner() {
        given().header("Authorization", "Bearer " + token(claims("user-a")))
                .header("x-intermesh-user", "user-b").get("/api/v1/account/ACC-ALICE/transactions")
                .then().statusCode(200).body("[0].transaction_id", is("TX-ACC-ALICE"));
        assertHistoryCalls(1, 1);
    }

    @Test
    void ownedAccountWithNoTransactionsReturnsEmptyHistory() {
        given().header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/account/ACC-EMPTY/transactions").then().statusCode(200)
                .body("size()", is(0));
        assertHistoryCalls(1, 1);
    }

    @Test
    void nullLedgerHistoryPreservesExistingEmptyResponse() {
        given().header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/account/ACC-NULL-HISTORY/transactions").then().statusCode(200)
                .body(is(""));
        assertHistoryCalls(1, 1);
    }

    @Test
    void ledgerAccountLookupFailuresPreserveHttpStatusWithoutFetchingHistory() {
        for (int status : List.of(500, 503)) {
            resetLedgerCalls();
            given().header("Authorization", "Bearer " + token(claims("user-a")))
                    .get("/api/v1/account/ACC-LOOKUP-" + status + "/transactions").then().statusCode(status)
                    .body("status", is("FAILED")).body("reason", is("Core Ledger request failed."))
                    .body("size()", is(2));
            assertHistoryCalls(1, 0);
        }
    }

    @Test
    void ledgerHistoryFailureRemainsADownstreamFailureAfterOwnershipCheck() {
        given().header("Authorization", "Bearer " + token(claims("user-a")))
                .get("/api/v1/account/ACC-HISTORY-FAIL/transactions").then().statusCode(503)
                .body("status", is("FAILED")).body("reason", is("Core Ledger request failed."))
                .body("size()", is(2));
        assertHistoryCalls(1, 1);
    }

    @Test
    void unusableLedgerAccountResponsesFailClosedWithoutFetchingHistory() {
        for (String id : List.of("ACC-NULL", "ACC-NO-OWNER", "ACC-BLANK-OWNER", "ACC-WRONG-ID")) {
            resetLedgerCalls();
            given().header("Authorization", "Bearer " + token(claims("user-a")))
                    .get("/api/v1/account/" + id + "/transactions").then().statusCode(502)
                    .body("status", is("FAILED"))
                    .body("reason", is("Core Ledger synchronization fault during lookup."));
            assertHistoryCalls(1, 0);
        }
    }

    @Test
    void historyOwnerComparisonIsExact() {
        for (String id : List.of("ACC-CASE", "ACC-PADDED")) {
            resetLedgerCalls();
            given().header("Authorization", "Bearer " + token(claims("user-a")))
                    .get("/api/v1/account/" + id + "/transactions").then().statusCode(403);
            assertHistoryCalls(1, 0);
        }
    }

    private String admissionAcknowledgment() {
        return "{\"status\":\"FROZEN\",\"transfer_request_id\":\"REQUEST_ID\",\"admission_status\":\"ADMITTED\","
                + "\"transaction_id\":\"TX-KNOWN\",\"transaction_state\":\"PENDING\",\"new_transaction_created\":true,"
                + "\"duplicate_pending_approved\":false,\"matching_pending_count\":1}";
    }

    private Map<String, Object> transferPayload(String source, String target) {
        return Map.of("transfer_request_id", UUID.randomUUID().toString(), "source_account", source, "target_account", target, "amount", 12.5);
    }

    private String monetaryBody(String field, String token) {
        return "{\"transfer_request_id\":\"" + UUID.randomUUID() + "\",\"source_account\":\"ACC-ALICE\",\"target_account\":\"ACC-BOB\",\"holder_name\":\"Test\",\""
                + field + "\":" + token + "}";
    }

    private Response monetaryRequest(String endpoint, String body, String jwt) {
        return given().header("Authorization", "Bearer " + jwt).contentType(ContentType.JSON)
                .body(body).post("/api/v1/" + endpoint);
    }

    private void assertRecordedAmount(String request, String field, String canonical) throws Exception {
        String snapshot = given().baseUri(fixtureUri.toString()).get("/test/ledger-calls")
                .then().statusCode(200).extract().asString();
        var node = new ObjectMapper().enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
                .readTree(snapshot).path("transfer").path(request).path(field);
        assertTrue(node.isNumber(), "outbound amount must be a JSON number");
        assertEquals(0, new BigDecimal(canonical).compareTo(node.decimalValue()));
    }

    @Test
    void invalidMonetaryTokensAreRejectedBeforeAllDownstreamCalls() {
        String jwt = token(claims("user-a"));
        for (String endpoint : List.of("accounts", "transfers")) {
            String field = endpoint.equals("accounts") ? "initial_deposit" : "amount";
            for (String value : MonetaryAmountsTest.INVALID) {
                monetaryRequest(endpoint, monetaryBody(field, value), jwt).then().statusCode(400)
                        .body("error", is("Invalid monetary request")).body("size()", is(1));
                noDownstreamCalls();
            }
            monetaryRequest(endpoint, monetaryBody(field, "1".repeat(257)), jwt).then().statusCode(400);
            noDownstreamCalls();
        }
    }

    @Test
    void missingZeroAndMalformedMonetaryBodiesAreRejected() {
        String jwt = token(claims("user-a"));
        for (String endpoint : List.of("accounts", "transfers")) {
            String field = endpoint.equals("accounts") ? "initial_deposit" : "amount";
            for (String body : List.of("{}", "null", "[]", "true", "", "{",
                    monetaryBody(field, "1") + " garbage", monetaryBody(field, "1") + " {}",
                    monetaryBody(field, "1") + " ".repeat(64 << 10))) {
                monetaryRequest(endpoint, body, jwt).then().statusCode(400);
                noDownstreamCalls();
            }
        }
        for (String zero : List.of("0", "0.00", "-0.00", "0e2")) {
            monetaryRequest("transfers", monetaryBody("amount", zero), jwt).then().statusCode(400)
                    .body("error", is("Invalid monetary request"));
            noDownstreamCalls();
        }
    }

    @Test
    void validExactTransferAmountsRemainNumericOnTheWire() throws Exception {
        String jwt = token(claims("user-a"));
        for (var tc : MonetaryAmountsTest.VALID) {
            resetLedgerCalls();
            monetaryRequest("transfers", monetaryBody("amount", tc.token()), jwt).then().statusCode(200);
            assertRecordedAmount("freezeRequest", "amount", tc.canonical());
            assertRecordedAmount("commitRequest", "amount", tc.canonical());
            given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                    .body("transfer.calls", is(List.of("lookup:ACC-ALICE", "freeze", "fraud", "commit")))
                    .body("transfer.mutationCalls", is(2));
        }
    }

    @Test
    void validExactOpeningDepositsIncludingExplicitZeroRemainNumeric() throws Exception {
        String jwt = token(claims("user-a"));
        for (var tc : MonetaryAmountsTest.VALID) {
            resetLedgerCalls();
            monetaryRequest("accounts", monetaryBody("initial_deposit", tc.token()), jwt).then().statusCode(201);
            assertRecordedAmount("creationRequest", "initial_deposit", tc.canonical());
            assertLedgerCalls(1, "user-a");
        }
        for (String zero : List.of("0", "0.00", "-0.00", "0e2")) {
            resetLedgerCalls();
            monetaryRequest("accounts", monetaryBody("initial_deposit", zero), jwt).then().statusCode(201);
            assertRecordedAmount("creationRequest", "initial_deposit", "0.00");
            assertLedgerCalls(1, "user-a");
        }
    }

    @Test
    void validatedDecimalIsReusedForAcknowledgedCompensation() throws Exception {
        transferOutcomes(Map.of("fraud", 503));
        assertCompensationResponse(monetaryRequest("transfers", monetaryBody("amount", "12.3000"),
                token(claims("user-a"))), "Transaction verification did not complete.",
                "Unfreeze request acknowledged by Ledger; restoration was not independently verified.");
        assertRecordedAmount("freezeRequest", "amount", "12.30");
        assertRecordedAmount("unfreezeRequest", "amount", "12.30");
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .body("transfer.calls", is(List.of("lookup:ACC-ALICE", "freeze", "fraud", "unfreeze")))
                .body("transfer.mutationCalls", is(2));
    }

    private Response transfer(String source, String target, String jwt, String session) {
        var request = given().contentType(ContentType.JSON).body(transferPayload(source, target));
        if (jwt != null) { request.header("Authorization", "Bearer " + jwt); }
        if (session != null) { request.cookie("JSESSIONID", session); }
        return request.post("/api/v1/transfers");
    }

    private void transferOutcomes(Map<String, ?> settings) {
        given().baseUri(fixtureUri.toString()).contentType(ContentType.JSON)
                .body(settings).post("/test/transfer-outcomes").then().statusCode(200);
    }

    private void assertCompensationResponse(Response response, String failure, String compensation) {
        response.then().statusCode(504).body("status", is("FAILED"))
                .body("reason", is(failure + " " + compensation)).body("size()", is(2));
        assertNoRestorationClaim(response);
        assertFinalizationMatchesFrozenTransaction("unfreezeRequest");
    }

    private void assertFinalizationMatchesFrozenTransaction(String requestName) {
        var transfer = given().baseUri(fixtureUri.toString()).get("/test/ledger-calls")
                .then().statusCode(200).extract().jsonPath();
        String id = transfer.getString("transfer." + requestName + ".transaction_id");
        Map<String, Map<String, Object>> transactions = transfer.getMap("transfer.transactions");
        assertEquals(1, transactions.size());
        assertTrue(transactions.containsKey(id));
        assertEquals(transfer.getString("transfer.freezeRequest.account_id"),
                transfer.getString("transfer." + requestName + ".account_id"));
        assertEquals(transfer.getString("transfer.freezeRequest.amount"),
                transfer.getString("transfer." + requestName + ".amount"));
        assertEquals(transfer.getString("transfer.freezeRequest.target_account"), transactions.get(id).get("target_iban"));
    }

    private void assertNoRestorationClaim(Response response) {
        String body = response.asString().toLowerCase(java.util.Locale.ROOT);
        assertFalse(body.contains("rolled back"));
        assertFalse(body.contains("funds unlocked"));
        assertFalse(body.contains("funds restored"));
    }

    private void assertTransferState(List<String> calls, int mutations, float balance, float frozen) {
        int fraud = (int) calls.stream().filter("fraud"::equals).count();
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then().statusCode(200)
                .body("count", is(calls.size() - fraud))
                .body("accountLookups", is((int) calls.stream().filter(call -> call.startsWith("lookup:")).count()))
                .body("historyCalls", is(0)).body("fraudCalls", is(fraud))
                .body("transfer.calls", is(calls))
                .body("transfer.freezeCalls", is((int) calls.stream().filter("freeze"::equals).count()))
                .body("transfer.commitCalls", is((int) calls.stream().filter("commit"::equals).count()))
                .body("transfer.unfreezeCalls", is((int) calls.stream().filter("unfreeze"::equals).count()))
                .body("transfer.mutationCalls", is(mutations))
                .body("transfer.balance", is(balance)).body("transfer.frozen", is(frozen));
    }

    @Test
    void transferWorkflowSuccessPreservesRequestsAndResponse() {
        String transactionId = transfer("ACC-ALICE", "ACC-BOB", token(claims("user-a")), null).then().statusCode(200)
                .body("ledgerTransferResponseDTO.status", is("COMMITTED"))
                .extract().path("ledgerTransferResponseDTO.transaction_id");
        assertTrue(transactionId.startsWith("TX-IM-"));
        assertTransferState(List.of("lookup:ACC-ALICE", "freeze", "fraud", "commit"), 2, 87.5f, 0.0f);
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .body("transfer.freezeRequest.account_id", is("ACC-ALICE"))
                .body("transfer.freezeRequest.target_account", is("ACC-BOB"))
                .body("transfer.freezeRequest.amount", is(12.5f))
                .body("transfer.freezeRequest.allowDuplicatePendingTransfer", is(false))
                .body("transfer.freezeRequest.size()", is(5))
                .body("transfer.commitRequest", is(Map.of("transaction_id", transactionId, "account_id", "ACC-ALICE", "amount", 12.5f)))
                .body("transfer.fraudRequest", is(Map.of("source_account", "ACC-ALICE",
                        "target_account", "ACC-BOB", "amount", 12.5f)));
    }

    @Test
    void unusableFreezeAcknowledgmentsStopWithoutRetryOrCompensation() throws Exception {
        String jwt = token(claims("user-a"));
        for (String id : List.of("null", "123", "true", "[]", "{}", "\"\"", "\" \"", "\"\\t\\n\"",
                "\"TX WITH SPACE\"", "\"TX\\u0000TEST\"", "\"" + "T".repeat(51) + "\"")) {
            resetLedgerCalls();
            transferOutcomes(Map.of("freezeBody", admissionAcknowledgment().replace("\"TX-KNOWN\"", id)));
            Response response = transfer("ACC-ALICE", "ACC-BOB", jwt, null);
            response.then().statusCode(502).body("status", is("FAILED"))
                    .body("reason", is("Ledger freeze acknowledgment was invalid; financial outcome was not confirmed."))
                    .body("size()", is(2));
            assertNoRestorationClaim(response);
            assertTransferState(List.of("lookup:ACC-ALICE", "freeze"), 1, 87.5f, 12.5f);
        }
    }

    @Test
    void invalidFreezeStatusAndMalformedBodiesStopAfterFreeze() {
        String jwt = token(claims("user-a"));
        for (String body : List.of(
                "{\"status\":\"FROZEN\"}",
                "{\"transaction_id\":\"TX-TEST\"}",
                "{\"status\":\"COMMITTED\",\"transaction_id\":\"TX-TEST\"}",
                "{\"status\":\"frozen\",\"transaction_id\":\"TX-TEST\"}",
                "{\"status\":\"FROZEN \",\"transaction_id\":\"TX-TEST\"}",
                "{\"status\":null,\"transaction_id\":\"TX-TEST\"}",
                "{\"status\":200,\"transaction_id\":\"TX-TEST\"}",
                "{\"status\":true,\"transaction_id\":\"TX-TEST\"}",
                "{\"status\":[],\"transaction_id\":\"TX-TEST\"}",
                "{\"status\":{},\"transaction_id\":\"TX-TEST\"}",
                "{\"status\":\"FROZEN\",\"tmp_tx_id\":\"TX-TEST\"}",
                "{", "", "null", "[]", "true", "{}",
                "{\"status\":\"FROZEN\",\"transaction_id\":\"TX-TEST\"} garbage",
                "{\"status\":\"FROZEN\",\"transaction_id\":\"TX-TEST\"} {}")) {
            resetLedgerCalls();
            transferOutcomes(Map.of("freezeBody", body));
            Response response = transfer("ACC-ALICE", "ACC-BOB", jwt, null);
            response.then().statusCode(502).body("status", is("FAILED"))
                    .body("reason", is("Ledger freeze acknowledgment was invalid; financial outcome was not confirmed."))
                    .body("size()", is(2));
            assertNoRestorationClaim(response);
            assertTransferState(List.of("lookup:ACC-ALICE", "freeze"), 1, 87.5f, 12.5f);
        }
    }

    @Test
    void opaqueFreezeIdentifiersWithinColumnLimitReachCommitUnchanged() throws Exception {
        String jwt = token(claims("user-a"));
        for (String id : List.of("TX-IM-1234abcd", "T".repeat(50), "\uD83D\uDE00".repeat(50))) {
            resetLedgerCalls();
            String body = admissionAcknowledgment().replace("TX-KNOWN", id);
            transferOutcomes(Map.of("freezeBody", body));
            transfer("ACC-ALICE", "ACC-BOB", jwt, null).then().statusCode(200)
                    .body("ledgerTransferResponseDTO.status", is("COMMITTED"))
                    .body("ledgerTransferResponseDTO.transaction_id", is(id));
            assertTransferState(List.of("lookup:ACC-ALICE", "freeze", "fraud", "commit"), 2, 87.5f, 0.0f);
            given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                    .body("transfer.commitRequest", is(Map.of("transaction_id", id, "account_id", "ACC-ALICE", "amount", 12.5f)));
        }
    }

    @Test
    void malformedCommitAcknowledgmentsNeverReportSuccessOrCompensateAnotherTransaction() {
        String jwt = token(claims("user-a"));
        for (String body : List.of("", "{", "null", "[]", "true", "{}",
                "{\"status\":\"COMMITTED\"}",
                "{\"transaction_id\":\"WRONG-ID\"}",
                "{\"status\":\"COMMITTED\",\"transaction_id\":\"WRONG-ID\"}",
                "{\"status\":\"APPROVED\",\"transaction_id\":\"TX-KNOWN\"}",
                "{\"status\":\"committed\",\"transaction_id\":\"TX-KNOWN\"}",
                "{\"status\":\"COMMITTED \",\"transaction_id\":\"TX-KNOWN\"}",
                "{\"status\":200,\"transaction_id\":\"WRONG-ID\"}",
                "{\"status\":\"COMMITTED\",\"transaction_id\":123}",
                "{\"status\":\"COMMITTED\",\"transaction_id\":null}",
                "{\"status\":\"COMMITTED\",\"transaction_id\":\"TX-KNOWN\"} {}",
                "{\"status\":\"COMMITTED\",\"transaction_id\":\"TX-KNOWN\"} garbage")) {
            resetLedgerCalls();
            transferOutcomes(Map.of("commitBody", body, "freezeBody", admissionAcknowledgment()));
            assertCompensationResponse(transfer("ACC-ALICE", "ACC-BOB", jwt, null),
                    "Ledger commit acknowledgment was invalid; financial outcome was not confirmed.",
                    "Unfreeze request failed; restoration was not confirmed.");
            assertTransferState(compensationCalls("commit"), 2, 87.5f, 0.0f);
            assertFinalizationMatchesFrozenTransaction("commitRequest");
        }
    }

    @Test
    void malformedCommitAcknowledgmentWithPendingTransactionAllowsScopedCompensation() {
        transferOutcomes(Map.of("commitMode", "acknowledge-only", "commitBody", "{}"));
        assertCompensationResponse(transfer("ACC-ALICE", "ACC-BOB", token(claims("user-a")), null),
                "Ledger commit acknowledgment was invalid; financial outcome was not confirmed.",
                "Unfreeze request acknowledged by Ledger; restoration was not independently verified.");
        assertTransferState(compensationCalls("commit"), 2, 100.0f, 0.0f);
    }

    @Test
    void destinationIsPreservedWithoutTruncationOrSettlement() {
        String jwt = token(claims("user-a"));
        for (String destination : List.of("TEST-IBAN-123", "T".repeat(34))) {
            resetLedgerCalls();
            String id = transfer("ACC-ALICE", destination, jwt, null).then().statusCode(200)
                    .extract().path("ledgerTransferResponseDTO.transaction_id");
            var snapshot = given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                    .statusCode(200).extract().jsonPath();
            Map<String, Map<String, Object>> transactions = snapshot.getMap("transfer.transactions");
            assertEquals(destination, transactions.get(id).get("target_iban"));
            assertFinalizationMatchesFrozenTransaction("commitRequest");
            assertTransferState(List.of("lookup:ACC-ALICE", "freeze", "fraud", "commit"), 2, 87.5f, 0.0f);
        }
        for (String destination : List.of("", " ", "T".repeat(35), "IBAN\u0000")) {
            resetLedgerCalls();
            transfer("ACC-ALICE", destination, jwt, null).then().statusCode(400);
            assertTransferState(List.of(), 0, 100.0f, 0.0f);
        }
    }

    @Test
    void twoPendingTransfersFinalizeIndependentlyAndRejectInvalidReferences() {
        String jwt = token(claims("user-a"));
        transferOutcomes(Map.of("fraud", 503, "unfreezeMode", "acknowledge-only"));
        String[] ids = new String[2];
        for (int i = 0; i < 2; i++) {
            var payload = new LinkedHashMap<>(transferPayload("ACC-ALICE", "ACC-BOB"));
            payload.put("allowDuplicatePendingTransfer", i == 1);
            correlatedTransfer(payload, jwt).then().statusCode(504);
            ids[i] = given().baseUri(fixtureUri.toString()).get("/test/ledger-calls")
                    .then().extract().path("transfer.unfreezeRequest.transaction_id");
        }
        assertNotEquals(ids[0], ids[1]);
        transferOutcomes(Map.of());
        Map<String, Object> a = Map.of("transaction_id", ids[0], "account_id", "ACC-ALICE", "amount", new BigDecimal("12.50"));
        Map<String, Object> b = Map.of("transaction_id", ids[1], "account_id", "ACC-ALICE", "amount", new BigDecimal("12.50"));
        for (String endpoint : List.of("commit", "unfreeze")) {
            given().baseUri(fixtureUri.toString()).contentType(ContentType.JSON)
                    .body(Map.of("account_id", "ACC-ALICE", "amount", 12.5))
                    .post("/v1/ledger/" + endpoint).then().statusCode(400);
            given().baseUri(fixtureUri.toString()).contentType(ContentType.JSON)
                    .body(Map.of("transaction_id", "UNKNOWN", "account_id", "ACC-ALICE", "amount", 12.5))
                    .post("/v1/ledger/" + endpoint).then().statusCode(404);
            given().baseUri(fixtureUri.toString()).contentType(ContentType.JSON)
                    .body(Map.of("transaction_id", ids[0], "account_id", "ACC-BOB", "amount", 12.5))
                    .post("/v1/ledger/" + endpoint).then().statusCode(404);
            given().baseUri(fixtureUri.toString()).contentType(ContentType.JSON)
                    .body(Map.of("transaction_id", ids[0], "account_id", "ACC-ALICE", "amount", 12.51))
                    .post("/v1/ledger/" + endpoint).then().statusCode(409);
        }
        assertSyntheticTransactions(ids[0], "PENDING", ids[1], "PENDING", 75.0f, 25.0f);
        given().baseUri(fixtureUri.toString()).contentType(ContentType.JSON).body(a)
                .post("/v1/ledger/commit").then().statusCode(200).body("transaction_id", is(ids[0]));
        assertSyntheticTransactions(ids[0], "APPROVED", ids[1], "PENDING", 75.0f, 12.5f);
        given().baseUri(fixtureUri.toString()).contentType(ContentType.JSON).body(b)
                .post("/v1/ledger/unfreeze").then().statusCode(200);
        for (String endpoint : List.of("commit", "unfreeze")) {
            for (Map<String, Object> ref : List.of(a, b)) {
                given().baseUri(fixtureUri.toString()).contentType(ContentType.JSON).body(ref)
                        .post("/v1/ledger/" + endpoint).then().statusCode(409);
            }
        }
        assertSyntheticTransactions(ids[0], "APPROVED", ids[1], "FAILED", 87.5f, 0.0f);
    }

    private void assertSyntheticTransactions(String a, String statusA, String b, String statusB, float balance, float frozen) {
        var state = given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .body("transfer.balance", is(balance)).body("transfer.frozen", is(frozen)).extract().jsonPath();
        Map<String, Map<String, Object>> transactions = state.getMap("transfer.transactions");
        assertEquals(statusA, transactions.get(a).get("status"));
        assertEquals(statusB, transactions.get(b).get("status"));
    }

    @Test
    void fraudGatewayTimeoutCompensatesOnlyTheFrozenTransaction() {
        transferOutcomes(Map.of("fraud", 504));
        assertCompensationResponse(transfer("ACC-ALICE", "ACC-BOB", token(claims("user-a")), null),
                "Transaction verification did not complete.",
                "Unfreeze request acknowledged by Ledger; restoration was not independently verified.");
        assertTransferState(List.of("lookup:ACC-ALICE", "freeze", "fraud", "unfreeze"), 2, 100.0f, 0.0f);
    }

    @Test
    void transferWorkflowFreezeRefusalStopsBeforeFraud() {
        transferOutcomes(Map.of("freeze", 201));
        Response response = transfer("ACC-ALICE", "ACC-BOB", token(claims("user-a")), null);
        response.then().statusCode(502).body("status", is("UNKNOWN"))
                .body("reason", is("Ledger admission or recovery was not acknowledged; financial outcome was not confirmed."));
        assertNoRestorationClaim(response);
        assertTransferState(List.of("lookup:ACC-ALICE", "freeze"), 0, 100.0f, 0.0f);
    }

    @Test
    void transferWorkflowFreezeFailureStopsBeforeFraud() {
        for (int status : List.of(422, 503, 504)) {
            resetLedgerCalls();
            transferOutcomes(Map.of("freeze", status));
            Response response = transfer("ACC-ALICE", "ACC-BOB", token(claims("user-a")), null);
            response.then().statusCode(502).body("status", is(status == 422 ? "FAILED" : "UNKNOWN"))
                    .body("reason", is(status == 422
                            ? "Ledger freeze acknowledgment was invalid; financial outcome was not confirmed."
                            : "Ledger admission or recovery was not acknowledged; financial outcome was not confirmed."));
            assertNoRestorationClaim(response);
            assertTransferState(List.of("lookup:ACC-ALICE", "freeze"), 0, 100.0f, 0.0f);
        }
    }

    @Test
    void transferWorkflowFraudRefusalCompensates() {
        transferOutcomes(Map.of("fraud", 201));
        assertCompensationResponse(transfer("ACC-ALICE", "ACC-BOB", token(claims("user-a")), null),
                "Transaction verification did not complete.",
                "Unfreeze request acknowledged by Ledger; restoration was not independently verified.");
        assertTransferState(List.of("lookup:ACC-ALICE", "freeze", "fraud", "unfreeze"), 2, 100.0f, 0.0f);
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .body("transfer.unfreezeRequest.account_id", is("ACC-ALICE"))
                .body("transfer.unfreezeRequest.amount", is(12.5f))
                .body("transfer.unfreezeRequest.size()", is(3));
        assertFinalizationMatchesFrozenTransaction("unfreezeRequest");
    }

    @Test
    void transferWorkflowFraudFailureCompensates() {
        transferOutcomes(Map.of("fraud", 503));
        assertCompensationResponse(transfer("ACC-ALICE", "ACC-BOB", token(claims("user-a")), null),
                "Transaction verification did not complete.",
                "Unfreeze request acknowledged by Ledger; restoration was not independently verified.");
        assertTransferState(List.of("lookup:ACC-ALICE", "freeze", "fraud", "unfreeze"), 2, 100.0f, 0.0f);
    }

    @Test
    void transferWorkflowCommitFailureCompensates() {
        transferOutcomes(Map.of("commit", 503));
        assertCompensationResponse(transfer("ACC-ALICE", "ACC-BOB", token(claims("user-a")), null),
                "Ledger commit outcome was not confirmed.",
                "Unfreeze request acknowledged by Ledger; restoration was not independently verified.");
        assertTransferState(List.of("lookup:ACC-ALICE", "freeze", "fraud", "commit", "unfreeze"), 2, 100.0f, 0.0f);
    }

    @Test
    void transferWorkflowFailedCompensationDoesNotRetry() {
        for (String failure : List.of("fraud", "commit")) {
            for (int status : List.of(403, 500, 503)) {
                resetLedgerCalls();
                transferOutcomes(Map.of(failure, 503, "unfreeze", status));
                assertCompensationResponse(transfer("ACC-ALICE", "ACC-BOB", token(claims("user-a")), null),
                        transferFailureMessage(failure),
                        "Unfreeze request failed; restoration was not confirmed.");
                assertTransferState(compensationCalls(failure), 1, 87.5f, 12.5f);
            }
        }
    }

    private String transferFailureMessage(String failure) {
        return failure.equals("fraud") ? "Transaction verification did not complete."
                : "Ledger commit outcome was not confirmed.";
    }

    private List<String> compensationCalls(String failure) {
        return failure.equals("fraud") ? List.of("lookup:ACC-ALICE", "freeze", "fraud", "unfreeze")
                : List.of("lookup:ACC-ALICE", "freeze", "fraud", "commit", "unfreeze");
    }

    @Test
    void transferWorkflowLostCompensationResponseIsUnknownWithoutRetry() {
        for (String failure : List.of("fraud", "commit")) {
            for (String mode : List.of("disconnect-before-mutation", "disconnect-after-mutation")) {
                resetLedgerCalls();
                transferOutcomes(Map.of(failure, 503, "unfreezeMode", mode));
                assertCompensationResponse(transfer("ACC-ALICE", "ACC-BOB", token(claims("user-a")), null),
                        transferFailureMessage(failure),
                        "Unfreeze outcome is unknown; restoration was not confirmed.");
                boolean restored = mode.equals("disconnect-after-mutation");
                assertTransferState(compensationCalls(failure), restored ? 2 : 1,
                        restored ? 100.0f : 87.5f, restored ? 0.0f : 12.5f);
            }
        }
    }

    @Test
    void transferWorkflowCompensationTimeoutResponseIsUnknown() {
        for (String failure : List.of("fraud", "commit")) {
            for (int status : List.of(408, 504)) {
                resetLedgerCalls();
                transferOutcomes(Map.of(failure, 503, "unfreeze", status));
                assertCompensationResponse(transfer("ACC-ALICE", "ACC-BOB", token(claims("user-a")), null),
                        transferFailureMessage(failure),
                        "Unfreeze outcome is unknown; restoration was not confirmed.");
                assertTransferState(compensationCalls(failure), 1, 87.5f, 12.5f);
            }
        }
    }

    @Test
    void transferWorkflowAcknowledgmentDoesNotProveRestoration() {
        for (String failure : List.of("fraud", "commit")) {
            resetLedgerCalls();
            transferOutcomes(Map.of(failure, 503, "unfreezeMode", "acknowledge-only"));
            assertCompensationResponse(transfer("ACC-ALICE", "ACC-BOB", token(claims("user-a")), null),
                    transferFailureMessage(failure),
                    "Unfreeze request acknowledged by Ledger; restoration was not independently verified.");
            assertTransferState(compensationCalls(failure), 1, 87.5f, 12.5f);
        }
    }

    @Test
    void transferWorkflowUnexpectedCompensationResponseIsUnknown() {
        for (String failure : List.of("fraud", "commit")) {
            resetLedgerCalls();
            transferOutcomes(Map.of(failure, 503, "unfreeze", 201));
            assertCompensationResponse(transfer("ACC-ALICE", "ACC-BOB", token(claims("user-a")), null),
                    transferFailureMessage(failure),
                    "Unfreeze outcome is unknown; restoration was not confirmed.");
            assertTransferState(compensationCalls(failure), 1, 87.5f, 12.5f);
        }
    }

    @Test
    void transferWorkflowLostFreezeResponseDoesNotRetryOrCompensate() {
        for (String mode : List.of("disconnect-before-mutation", "disconnect-after-mutation")) {
            resetLedgerCalls();
            transferOutcomes(Map.of("freezeMode", mode));
            Response response = transfer("ACC-ALICE", "ACC-BOB", token(claims("user-a")), null);
            response.then().statusCode(504).body("status", is("FAILED"))
                    .body("reason", is("Ledger freeze was not acknowledged; financial outcome was not confirmed."));
            assertNoRestorationClaim(response);
            boolean frozen = mode.equals("disconnect-after-mutation");
            assertTransferState(List.of("lookup:ACC-ALICE", "freeze"), frozen ? 1 : 0,
                    frozen ? 87.5f : 100.0f, frozen ? 12.5f : 0.0f);
        }
    }

    @Test
    void transferWorkflowLostCommitResponsePreservesUnknownOutcome() {
        for (String mode : List.of("acknowledge-only", "explicit-failure", "disconnect-before-mutation")) {
            resetLedgerCalls();
            transferOutcomes(Map.of("commitMode", "disconnect-after-mutation",
                    "unfreeze", mode.equals("explicit-failure") ? 503 : 200, "unfreezeMode", mode));
            String compensation = switch (mode) {
                case "acknowledge-only" -> "Unfreeze request failed; restoration was not confirmed.";
                case "explicit-failure" -> "Unfreeze request failed; restoration was not confirmed.";
                default -> "Unfreeze outcome is unknown; restoration was not confirmed.";
            };
            assertCompensationResponse(transfer("ACC-ALICE", "ACC-BOB", token(claims("user-a")), null),
                    "Ledger commit outcome was not confirmed.", compensation);
            assertTransferState(compensationCalls("commit"), 2, 87.5f, 0.0f);
        }
    }

    @Test
    void anotherOwnersTransferSourceIsForbiddenRegardlessOfDestination() {
        for (String destination : List.of("ACC-ALICE", "ACC-BOB")) {
            String session = aliceSession();
            Response denied = transfer("ACC-BOB", destination, token(claims("user-a")), session);
            denied.then().statusCode(403).body("error", is("Access denied")).body("size()", is(1));
            assertNull(denied.getCookie("JSESSIONID"));
            assertTransferState(List.of("lookup:ACC-BOB"), 0, 100.0f, 0.0f);
        }
    }

    @Test
    void transferSessionMismatchInvalidatesBeforeAnyLookupOrMutation() {
        String session = aliceSession();
        String bobJwt = token(claims("user-b"));
        Response denied = transfer("ACC-BOB", "ACC-ALICE", bobJwt, session);
        denied.then().statusCode(403).body("error", is("Access denied"));
        expiredSessionCookie(denied);
        assertTransferState(List.of(), 0, 100.0f, 0.0f);
        transfer("ACC-BOB", "ACC-ALICE", bobJwt, null).then().statusCode(200);
        assertTransferState(List.of("lookup:ACC-BOB", "freeze", "fraud", "commit"), 2, 87.5f, 0.0f);
    }

    @Test
    void transferRequiresCurrentValidBearerBeforeAnyLookupOrMutation() {
        String session = aliceSession();
        transfer("ACC-ALICE", "ACC-BOB", null, session).then().statusCode(401);
        assertTransferState(List.of(), 0, 100.0f, 0.0f);
        Map<String, Object> expired = claims("user-a");
        expired.put("exp", Instant.now().minusSeconds(300).getEpochSecond());
        Map<String, Object> wrongIssuer = claims("user-a");
        wrongIssuer.put("iss", "https://other-issuer.example.invalid/realms/intermesh-bank");
        Map<String, Object> unusable = claims("user-a");
        unusable.remove("preferred_username");
        for (String jwt : List.of("not-a-jwt", token(claims("user-a"), "/test/token/invalid-signature"),
                token(expired), token(wrongIssuer), token(unusable))) {
            transfer("ACC-ALICE", "ACC-BOB", jwt, session).then().statusCode(401);
            assertTransferState(List.of(), 0, 100.0f, 0.0f);
        }
    }

    @Test
    void forgedIdentityHeaderCannotAuthorizeATransfer() {
        given().header("x-intermesh-user", "user-a").contentType(ContentType.JSON)
                .body(transferPayload("ACC-ALICE", "ACC-BOB")).post("/api/v1/transfers")
                .then().statusCode(401);
        assertTransferState(List.of(), 0, 100.0f, 0.0f);
        given().header("Authorization", "Bearer " + token(claims("user-a")))
                .header("x-intermesh-user", "user-b").contentType(ContentType.JSON)
                .body(transferPayload("ACC-BOB", "ACC-BOB")).post("/api/v1/transfers")
                .then().statusCode(403).body("error", is("Access denied"));
        assertTransferState(List.of("lookup:ACC-BOB"), 0, 100.0f, 0.0f);
    }

    @Test
    void ownedTransferUsesRequestSourceDespiteCachedAccountAndForgedHeader() {
        String session = aliceSession(); // Lookup cached ACC-TEST, not the transfer's source.
        given().cookie("JSESSIONID", session).header("Authorization", "Bearer " + token(claims("user-a")))
                .header("x-intermesh-user", "user-b").contentType(ContentType.JSON)
                .body(transferPayload("ACC-ALICE", "ACC-BOB")).post("/api/v1/transfers")
                .then().statusCode(200);
        assertTransferState(List.of("lookup:ACC-ALICE", "freeze", "fraud", "commit"), 2, 87.5f, 0.0f);
    }

    @Test
    void unknownTransferSourceIsNotFoundWithoutAnyFinancialMutation() {
        transfer("ACC-MISSING", "ACC-BOB", token(claims("user-a")), null).then().statusCode(404)
                .body("error", is("Account not found")).body("size()", is(1));
        assertTransferState(List.of("lookup:ACC-MISSING"), 0, 100.0f, 0.0f);
    }

    @Test
    void malformedTransferSourceResponsesFailClosedBeforeAnyFinancialMutation() {
        for (String source : List.of("ACC-NULL", "ACC-NO-OWNER", "ACC-BLANK-OWNER", "ACC-WRONG-ID",
                "ACC-NO-ID", "ACC-MALFORMED")) {
            resetLedgerCalls();
            transfer(source, "ACC-BOB", token(claims("user-a")), null).then().statusCode(502)
                    .body("status", is("FAILED")).body("reason", is("Core Ledger source account lookup failed."))
                    .body("size()", is(2));
            assertTransferState(List.of("lookup:" + source), 0, 100.0f, 0.0f);
        }
    }

    @Test
    void transferSourceLookupFailuresPreserveStatusWithoutAnyFinancialMutation() {
        for (int status : List.of(500, 503)) {
            resetLedgerCalls();
            String source = "ACC-LOOKUP-" + status;
            transfer(source, "ACC-BOB", token(claims("user-a")), null).then().statusCode(status)
                    .body("status", is("FAILED")).body("reason", is("Core Ledger request failed."))
                    .body("size()", is(2));
            assertTransferState(List.of("lookup:" + source), 0, 100.0f, 0.0f);
        }
    }

    @Test
    void transferOwnerComparisonIsExact() {
        for (String source : List.of("ACC-CASE", "ACC-PADDED")) {
            resetLedgerCalls();
            transfer(source, "ACC-BOB", token(claims("user-a")), null).then().statusCode(403)
                    .body("error", is("Access denied"));
            assertTransferState(List.of("lookup:" + source), 0, 100.0f, 0.0f);
        }
    }

    @Test
    void missingTransferSourceFailsBeforeAnyLookupOrMutation() {
        String jwt = token(claims("user-a"));
        for (Map<String, Object> payload : List.of(Map.<String, Object>of("target_account", "ACC-BOB", "amount", 12.5),
                transferPayload("", "ACC-BOB"), transferPayload(" ", "ACC-BOB"))) {
            given().header("Authorization", "Bearer " + jwt).contentType(ContentType.JSON)
                    .body(payload).post("/api/v1/transfers").then().statusCode(400)
                    .body("error", is("Source account is required"));
            assertTransferState(List.of(), 0, 100.0f, 0.0f);
        }
        given().header("Authorization", "Bearer " + jwt).contentType(ContentType.JSON).body("null")
                .post("/api/v1/transfers").then().statusCode(400);
        assertTransferState(List.of(), 0, 100.0f, 0.0f);
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
    private Response correlatedTransfer(Map<String, Object> payload, String jwt) {
        return given().header("Authorization", "Bearer " + jwt).contentType(ContentType.JSON)
                .body(payload).post("/api/v1/transfers");
    }

    private Response recover(String id, String jwt) {
        return given().header("Authorization", "Bearer " + jwt)
                .get("/api/v1/transfer-requests/" + id);
    }

    @Test
    void transferRequiresStrictUuidAndBooleanBeforeDownstreamCalls() throws Exception {
        String jwt = token(claims("user-a"));
        ObjectMapper mapper = new ObjectMapper();
        for (String value : List.of("null", "123", "true", "[]", "{}", "\"\"", "\"not-a-uuid\"", "\"1-1-1-1-1\"")) {
            var body = mapper.valueToTree(transferPayload("ACC-ALICE", "ACC-BOB"));
            ((com.fasterxml.jackson.databind.node.ObjectNode) body).set("transfer_request_id", mapper.readTree(value));
            monetaryRequest("transfers", mapper.writeValueAsString(body), jwt).then().statusCode(400);
            noDownstreamCalls();
        }
        var missing = new LinkedHashMap<>(transferPayload("ACC-ALICE", "ACC-BOB"));
        missing.remove("transfer_request_id");
        correlatedTransfer(missing, jwt).then().statusCode(400);
        noDownstreamCalls();
        for (String flag : List.of("null", "0", "1", "\"false\"", "\"true\"", "[]", "{}")) {
            var body = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.valueToTree(transferPayload("ACC-ALICE", "ACC-BOB"));
            body.set("allowDuplicatePendingTransfer", mapper.readTree(flag));
            monetaryRequest("transfers", body.toString(), jwt).then().statusCode(400);
            noDownstreamCalls();
        }
        String duplicate = mapper.writeValueAsString(transferPayload("ACC-ALICE", "ACC-BOB"))
                .replace("\"amount\":12.5", "\"allowDuplicatePendingTransfer\":true,\"allowDuplicatePendingTransfer\":false,\"amount\":12.5");
        monetaryRequest("transfers", duplicate, jwt).then().statusCode(400);
        noDownstreamCalls();
    }

    @Test
    void ledgerIdentityHeadersComeOnlyFromVerifiedJwt() {
        String jwt = token(claims("user-a"));
        var payload = new LinkedHashMap<>(transferPayload("ACC-ALICE", "ACC-BOB"));
        payload.put("allowDuplicatePendingTransfer", false);
        given().header("Authorization", "Bearer " + jwt)
                .header("X-Intermesh-Issuer", "forged-issuer")
                .header("X-Intermesh-Subject", "forged-subject")
                .header("X-Intermesh-Owner-Key", "user-b").header("x-intermesh-user", "user-b")
                .contentType(ContentType.JSON).body(payload).post("/api/v1/transfers").then().statusCode(200);
        assertVerifiedLedgerHeaders();
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .body("transfer.freezeRequest.transfer_request_id", is(payload.get("transfer_request_id")))
                .body("transfer.freezeRequest.allowDuplicatePendingTransfer", is(false));
        given().header("Authorization", "Bearer " + jwt)
                .header("X-Intermesh-Issuer", "forged-issuer").header("X-Intermesh-Subject", "forged-subject")
                .header("X-Intermesh-Owner-Key", "user-b")
                .get("/api/v1/transfer-requests/" + payload.get("transfer_request_id"))
                .then().statusCode(200).header("Cache-Control", is("no-store"));
        assertVerifiedLedgerHeaders();
    }

    private void assertVerifiedLedgerHeaders() {
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .body("transfer.identityHeaders", is(Map.of("X-Intermesh-Issuer", fixtureUri + "/realms/intermesh-bank",
                        "X-Intermesh-Subject", "subject-user-a", "X-Intermesh-Owner-Key", "user-a")));
    }

    @Test
    void replayReturnsStoredStateWithoutRepeatingWorkflow() {
        String jwt = token(claims("user-a"));
        for (String state : List.of("APPROVED", "PENDING", "FAILED")) {
            resetLedgerCalls();
            var payload = transferPayload("ACC-ALICE", "ACC-BOB");
            if (!state.equals("APPROVED")) transferOutcomes(Map.of("fraud", 503,
                    "unfreezeMode", state.equals("PENDING") ? "acknowledge-only" : "normal"));
            correlatedTransfer(payload, jwt).then().statusCode(state.equals("APPROVED") ? 200 : 504);
            correlatedTransfer(payload, jwt).then().statusCode(200).header("Cache-Control", is("no-store"))
                    .body("status", is("REPLAYED")).body("admission_status", is("ADMITTED"))
                    .body("transaction_state", is(state)).body("new_transaction_created", is(false));
            given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                    .body("transfer.freezeCalls", is(2)).body("fraudCalls", is(1))
                    .body("transfer.commitCalls", is(state.equals("APPROVED") ? 1 : 0))
                    .body("transfer.unfreezeCalls", is(state.equals("APPROVED") ? 0 : 1));
            recover((String) payload.get("transfer_request_id"), jwt).then().statusCode(200)
                    .body("transaction_state", is(state)).body("new_transaction_created", is(false));
        }
    }

    @Test
    void domainRejectionsPersistAndIntentConflictsNeverRepeatFinancialCalls() {
        String jwt = token(claims("user-a"));
        for (String code : List.of("DUPLICATE_APPROVAL_REQUIRED", "DUPLICATE_APPROVAL_NOT_ELIGIBLE",
                "DUPLICATE_EXCEPTION_USED", "ACTIVE_CYCLE_BLOCKED", "ACTIVE_CYCLE_CONFLICT", "INSUFFICIENT_FUNDS")) {
            resetLedgerCalls();
            transferOutcomes(Map.of("admissionRejection", code));
            var payload = transferPayload("ACC-ALICE", "ACC-BOB");
            for (int i = 0; i < 2; i++) correlatedTransfer(payload, jwt).then()
                    .statusCode(code.equals("INSUFFICIENT_FUNDS") ? 422 : 409)
                    .body("admission_status", is("REJECTED")).body("rejection_code", is(code))
                    .body("new_transaction_created", is(false));
            recover((String) payload.get("transfer_request_id"), jwt).then().statusCode(200)
                    .body("admission_status", is("REJECTED")).body("rejection_code", is(code));
            given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                    .body("fraudCalls", is(0)).body("transfer.mutationCalls", is(0))
                    .body("transfer.commitCalls", is(0)).body("transfer.unfreezeCalls", is(0));
            var conflict = new LinkedHashMap<>(payload);
            conflict.put("amount", 13);
            correlatedTransfer(conflict, jwt).then().statusCode(409).body("code", is("REQUEST_INTENT_CONFLICT"));
        }
    }

    @Test
    void recoveryRequiresVerifiedSubjectAndSessionAndIsReadOnly() {
        String jwt = token(claims("user-a"));
        var payload = transferPayload("ACC-ALICE", "ACC-BOB");
        String id = (String) payload.get("transfer_request_id");
        recover(id, jwt).then().statusCode(404).header("Cache-Control", is("no-store"))
                .body("error", is("Request not found or inaccessible; an in-flight admission may still complete."));
        String session = correlatedTransfer(payload, jwt).then().statusCode(200).extract().cookie("JSESSIONID");
        recover(id, jwt).then().statusCode(200).body("status", is("RECOVERED"))
                .body("transaction_state", is("APPROVED")).header("Cache-Control", is("no-store"));
        recover(id, token(claims("user-b"))).then().statusCode(404);
        given().cookie("JSESSIONID", session).get("/api/v1/transfer-requests/" + id).then().statusCode(401);
        given().cookie("JSESSIONID", session).header("Authorization", "Bearer " + token(claims("user-b")))
                .get("/api/v1/transfer-requests/" + id).then().statusCode(403).header("Cache-Control", is("no-store"));
        recover(id, token(claims("user-a"), "/test/token/invalid-signature")).then().statusCode(401);
        recover("not-a-uuid", jwt).then().statusCode(400).header("Cache-Control", is("no-store"));
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .body("transfer.freezeCalls", is(1)).body("transfer.commitCalls", is(1))
                .body("transfer.unfreezeCalls", is(0)).body("fraudCalls", is(1)).body("transfer.recoveryCalls", is(3));
    }

    @Test
    void lostFreezeResponseIsRecoveredWithoutRestartingPendingTransfer() {
        String jwt = token(claims("user-a"));
        var payload = transferPayload("ACC-ALICE", "ACC-BOB");
        transferOutcomes(Map.of("freezeMode", "disconnect-after-mutation"));
        Response failed = correlatedTransfer(payload, jwt);
        failed.then().statusCode(504);
        assertNoRestorationClaim(failed);
        String id = (String) payload.get("transfer_request_id");
        recover(id, jwt).then().statusCode(200).body("transaction_state", is("PENDING"))
                .body("new_transaction_created", is(false));
        correlatedTransfer(payload, jwt).then().statusCode(200).body("status", is("REPLAYED"))
                .body("transaction_state", is("PENDING"));
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .body("transfer.freezeCalls", is(2)).body("transfer.mutationCalls", is(1))
                .body("fraudCalls", is(0)).body("transfer.commitCalls", is(0)).body("transfer.unfreezeCalls", is(0));
    }

    @Test
    void unusableAdmissionCorrelationAndTypesNeverReachFraudOrFinalization() throws Exception {
        String jwt = token(claims("user-a"));
        var mapper = new ObjectMapper();
        Map<String, String> changes = Map.ofEntries(
                Map.entry("transfer_request_id", "\"00000000-0000-4000-8000-000000000099\""),
                Map.entry("admission_status", "\"REJECTED\""),
                Map.entry("transaction_state", "\"APPROVED\""),
                Map.entry("new_transaction_created", "\"true\""),
                Map.entry("duplicate_pending_approved", "true"),
                Map.entry("matching_pending_count", "-1"), Map.entry("status", "\"REPLAYED\""));
        for (var change : changes.entrySet()) {
            resetLedgerCalls();
            var body = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(admissionAcknowledgment());
            body.set(change.getKey(), mapper.readTree(change.getValue()));
            transferOutcomes(Map.of("freezeBody", body.toString()));
            transfer("ACC-ALICE", "ACC-BOB", jwt, null).then().statusCode(502);
            assertTransferState(List.of("lookup:ACC-ALICE", "freeze"), 1, 87.5f, 12.5f);
        }
        resetLedgerCalls();
        transferOutcomes(Map.of("freeze", 503, "freezeBody", "{\"code\":\"COMMIT_OUTCOME_UNKNOWN\"}"));
        transfer("ACC-ALICE", "ACC-BOB", jwt, null).then().statusCode(503)
                .body("code", is("COMMIT_OUTCOME_UNKNOWN"));
        assertTransferState(List.of("lookup:ACC-ALICE", "freeze"), 0, 100.0f, 0.0f);
    }

    @Test
    void concurrentReplayCannotLaunchASecondTransferWorkflow() throws Exception {
        String jwt = token(claims("user-a"));
        var payload = transferPayload("ACC-ALICE", "ACC-BOB");
        var a = CompletableFuture.supplyAsync(() -> correlatedTransfer(payload, jwt));
        var b = CompletableFuture.supplyAsync(() -> correlatedTransfer(payload, jwt));
        Response first = a.get(15, TimeUnit.SECONDS);
        Response second = b.get(15, TimeUnit.SECONDS);
        first.then().statusCode(200);
        second.then().statusCode(200);
        int replayCount = ("REPLAYED".equals(first.jsonPath().getString("status")) ? 1 : 0)
                + ("REPLAYED".equals(second.jsonPath().getString("status")) ? 1 : 0);
        assertEquals(1, replayCount);
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .body("transfer.freezeCalls", is(2)).body("fraudCalls", is(1))
                .body("transfer.commitCalls", is(1)).body("transfer.unfreezeCalls", is(0))
                .body("transfer.mutationCalls", is(2));
    }

    @Test
    void recoveryReportsRecordedStateAfterLostFinalizationResponses() {
        String jwt = token(claims("user-a"));
        for (String failure : List.of("commit", "unfreeze")) {
            resetLedgerCalls();
            var payload = transferPayload("ACC-ALICE", "ACC-BOB");
            transferOutcomes(failure.equals("commit") ? Map.of("commitMode", "disconnect-after-mutation")
                    : Map.of("fraud", 503, "unfreezeMode", "disconnect-after-mutation"));
            Response response = correlatedTransfer(payload, jwt);
            response.then().statusCode(504);
            assertNoRestorationClaim(response);
            recover((String) payload.get("transfer_request_id"), jwt).then().statusCode(200)
                    .body("transaction_state", is(failure.equals("commit") ? "APPROVED" : "FAILED"));
            given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                    .body("transfer.mutationCalls", is(2)).body("fraudCalls", is(1))
                    .body("transfer.commitCalls", is(failure.equals("commit") ? 1 : 0))
                    .body("transfer.unfreezeCalls", is(1));
        }
    }

    @Test
    void recoveryRejectsUncorrelatedOrMutatingAcknowledgment() {
        String jwt = token(claims("user-a"));
        var payload = transferPayload("ACC-ALICE", "ACC-BOB");
        correlatedTransfer(payload, jwt).then().statusCode(200);
        transferOutcomes(Map.of("recoveryBody", admissionAcknowledgment()));
        recover((String) payload.get("transfer_request_id"), jwt).then().statusCode(502)
                .header("Cache-Control", is("no-store")).body("status", is("UNKNOWN"));
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .body("transfer.freezeCalls", is(1)).body("fraudCalls", is(1))
                .body("transfer.commitCalls", is(1)).body("transfer.unfreezeCalls", is(0));
    }

}
