import sqlite3
import time

def setup_db():
    db_path = "feedflash.db"
    print(f"Connecting to {db_path}...")
    
    # Use a longer timeout in case the database is locked by another process
    conn = sqlite3.connect(db_path, timeout=10.0)
    cursor = conn.cursor()

    try:
        # Create paper_portfolio table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS paper_portfolio (
                id INTEGER PRIMARY KEY,
                cash_balance REAL DEFAULT 100000.0,
                updated_at INTEGER
            )
        """)
        
        # Create paper_positions table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS paper_positions (
                ticker TEXT PRIMARY KEY,
                shares INTEGER,
                avg_entry_price REAL,
                entry_timestamp INTEGER
            )
        """)
        
        # Create paper_trade_history table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS paper_trade_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticker TEXT,
                action TEXT,
                shares INTEGER,
                price REAL,
                timestamp INTEGER,
                fast_reward REAL,
                slow_reward REAL,
                total_reward REAL
            )
        """)
        
        # Seed initial portfolio balance
        cursor.execute("""
            INSERT OR IGNORE INTO paper_portfolio (id, cash_balance, updated_at) 
            VALUES (1, 100000.0, ?)
        """, (int(time.time()),))
        
        conn.commit()
        print("Database setup completed successfully.")
        
    except sqlite3.Error as e:
        print(f"SQLite error occurred: {e}")
    finally:
        conn.close()

if __name__ == "__main__":
    setup_db()
