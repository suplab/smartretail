package com.smartretail.ims.adapter.inbound.rest;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * ⚠️ INTENTIONAL VULNERABILITY DEMONSTRATION — DO NOT SHIP ⚠️
 *
 * This controller was added deliberately to exercise the CodeQL PR pipeline. Every method
 * below contains a well-known insecure pattern so that we can confirm the static-analysis
 * gate flags them on the pull request. None of these endpoints belong in the real IMS
 * service — this whole file is expected to be reverted once the CodeQL wiring is verified.
 *
 * Findings this is designed to trigger (CodeQL Java query IDs):
 *   - java/sql-injection
 *   - java/command-line-injection
 *   - java/path-injection
 *   - java/weak-cryptographic-algorithm
 *   - java/insecure-randomness
 *   - java/hardcoded-credential-api-call
 *   - java/cleartext-logging-of-sensitive-information
 */
@RestController
@RequestMapping("/internal/security-demo")
public class SecurityDemoController {

    private static final Logger log = LoggerFactory.getLogger(SecurityDemoController.class);

    // ⚠️ Hardcoded credential — java/hardcoded-credentials
    private static final String DB_PASSWORD = "S3cr3t-P@ssw0rd-do-not-use";

    private final NamedParameterJdbcTemplate jdbc;

    public SecurityDemoController(NamedParameterJdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ⚠️ SQL injection — user input concatenated straight into the query string.
    @GetMapping("/lookup")
    public List<Map<String, Object>> lookup(@RequestParam String dcId) {
        String sql = "SELECT position_id, sku_id, dc_id, on_hand "
                + "FROM inventory.inventory_positions WHERE dc_id = '" + dcId + "'";
        return jdbc.getJdbcTemplate().queryForList(sql);
    }

    // ⚠️ OS command injection — request param passed to a shell.
    @GetMapping("/ping")
    public String ping(@RequestParam String host) throws IOException {
        Process process = Runtime.getRuntime().exec("ping -c 1 " + host);
        return "started ping pid=" + process.pid();
    }

    // ⚠️ Path traversal — request param used to build a file path with no validation.
    @GetMapping("/report")
    public String report(@RequestParam String fileName) throws IOException {
        Path path = Path.of("/var/smartretail/reports", fileName);
        return new String(Files.readAllBytes(path));
    }

    // ⚠️ Weak hashing algorithm (MD5) used for a security-sensitive digest.
    @GetMapping("/digest")
    public String digest(@RequestParam String value) throws NoSuchAlgorithmException {
        MessageDigest md = MessageDigest.getInstance("MD5");
        byte[] hash = md.digest(value.getBytes());
        StringBuilder sb = new StringBuilder();
        for (byte b : hash) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    // ⚠️ Insecure randomness — java.util.Random used to mint a session-like token.
    @GetMapping("/token")
    public String token() {
        Random random = new Random();
        return "token-" + Long.toHexString(random.nextLong());
    }

    // ⚠️ Cleartext logging of sensitive information + hardcoded-credential DB connect.
    @GetMapping("/connect")
    public String connect(@RequestParam String password) throws SQLException {
        log.info("Authenticating with password={}", password);
        String url = "jdbc:postgresql://localhost:5432/smartretail";
        try (Connection conn = DriverManager.getConnection(url, "sr_app", DB_PASSWORD)) {
            return "connected=" + (conn != null);
        }
    }
}
