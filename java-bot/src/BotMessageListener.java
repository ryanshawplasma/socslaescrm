import org.telegram.telegrambots.bots.TelegramLongPollingBot;
import org.telegram.telegrambots.meta.api.methods.send.SendMessage;
import org.telegram.telegrambots.meta.api.objects.Update;
import java.util.Set;

public class BotMessageListener extends TelegramLongPollingBot {

    // ── PASTE YOUR TEAM'S TELEGRAM USER IDs HERE ──────────────────────────────
    // Get your ID by sending /start to @userinfobot on Telegram
    private static final Set<Long> ALLOWED_USERS = Set.of(
        123456789L,   // ← replace with real IDs
        987654321L,
        111222333L
    );
    // ──────────────────────────────────────────────────────────────────────────

    @Override
    public String getBotToken() {
        String t = System.getenv("TELEGRAM_BOT_TOKEN");
        if (t == null) throw new IllegalStateException("TELEGRAM_BOT_TOKEN env var not set");
        return t;
    }

    @Override
    public String getBotUsername() {
        // Return your bot's @username (without the @)
        return System.getenv().getOrDefault("BOT_USERNAME", "YourBotUsername");
    }

    @Override
    public void onUpdateReceived(Update update) {
        if (!update.hasMessage() || !update.getMessage().hasText()) return;

        long senderId = update.getMessage().getFrom().getId();
        if (!ALLOWED_USERS.contains(senderId)) {
            System.out.println("⚠ Blocked unauthorised user: " + senderId);
            return;
        }

        String text   = update.getMessage().getText();
        long   chatId = update.getMessage().getChatId();

        try {
            DatabaseManager.saveMessage(senderId, text);
            send(chatId, "✅ Received: " + text);
        } catch (Exception e) {
            System.err.println("Error handling message: " + e.getMessage());
            try { send(chatId, "❌ Internal error, please try again."); } catch (Exception ignored) {}
        }
    }

    private void send(long chatId, String text) throws Exception {
        execute(SendMessage.builder()
            .chatId(String.valueOf(chatId))
            .text(text)
            .build());
    }
}
