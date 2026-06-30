import com.sun.net.httpserver.HttpServer;
import org.telegram.telegrambots.meta.TelegramBotsApi;
import org.telegram.telegrambots.updatesreceivers.DefaultBotSession;
import java.io.OutputStream;
import java.net.InetSocketAddress;

public class Main {
    public static void main(String[] args) throws Exception {
        // ── Health-check HTTP server (required by Hugging Face) ──────────────
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
        HttpServer health = HttpServer.create(new InetSocketAddress(port), 0);
        health.createContext("/", exchange -> {
            byte[] body = "Bot is running!".getBytes();
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(body);
            }
        });
        health.setExecutor(null);
        health.start();
        System.out.println("✅ Health-check server listening on port " + port);

        // ── Init DB schema ────────────────────────────────────────────────────
        DatabaseManager.initSchema();
        System.out.println("✅ Database schema ready");

        // ── Register Telegram bot ─────────────────────────────────────────────
        TelegramBotsApi api = new TelegramBotsApi(DefaultBotSession.class);
        api.registerBot(new BotMessageListener());
        System.out.println("🤖 Telegram bot is running");
    }
}
