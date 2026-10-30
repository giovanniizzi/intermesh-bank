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
import java.net.URI;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
                        ? Map.of("source_account", "ACC-TEST", "target_account", "ACC-OTHER", "amount", 1)
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
                .body(Map.of("source_account", "ACC-TEST", "target_account", "ACC-OTHER", "amount", 1))
                .post("/api/v1/transfers").then().statusCode(200);
        given().baseUri(fixtureUri.toString()).get("/test/ledger-calls").then()
                .body("count", is(5)).body("fraudCalls", is(1));
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
