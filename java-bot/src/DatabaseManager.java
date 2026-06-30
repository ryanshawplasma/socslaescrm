import java.sql.*;

public class DatabaseManager {
    private static final String DB_URL  = System.getenv("DB_URL");
    private static final String DB_USER = System.getenv("DB_USER");
    private static final String DB_PASS = System.getenv("DB_PASS");

    public static Connection getConnection() throws SQLException {
        if (DB_URL == null || DB_USER == null || DB_PASS == null)
            throw new IllegalStateException("DB_URL / DB_USER / DB_PASS env vars not set");
        return DriverManager.getConnection(DB_URL, DB_USER, DB_PASS);
    }

    /** Initialise schema — call once at startup */
    public static void initSchema() throws SQLException {
        String sql = """
            CREATE TABLE IF NOT EXISTS messages (
              id         BIGINT AUTO_INCREMENT PRIMARY KEY,
              user_id    BIGINT       NOT NULL,
              content    TEXT         NOT NULL,
              created_at DATETIME     NOT NULL DEFAULT NOW()
            )
            """;
        try (Connection c = getConnection();
             Statement st = c.createStatement()) {
            st.executeUpdate(sql);
        }
    }

    public static void saveMessage(long userId, String text) throws SQLException {
        String sql = "INSERT INTO messages (user_id, content, created_at) VALUES (?, ?, NOW())";
        try (Connection c = getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setLong(1, userId);
            ps.setString(2, text);
            ps.executeUpdate();
        }
    }
}
