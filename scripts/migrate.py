import sqlite3
import os
import json

def migrate():
    db_path = "/data/noteflow.db"
    
    # If running locally for testing, the DB might be in a local /data instead of the root
    if not os.path.exists(db_path) and os.path.exists("data/noteflow.db"):
        db_path = "data/noteflow.db"

    if not os.path.exists(db_path):
        print(f"Database not found at {db_path}. No migration needed.")
        return

    print("Connecting to database...")
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        print("Checking users table...")
        cursor.execute("PRAGMA table_info(users)")
        columns = [c[1] for c in cursor.fetchall()]
        if "settings" not in columns:
            print("Adding settings column to users table...")
            cursor.execute("ALTER TABLE users ADD COLUMN settings JSON DEFAULT '{}'")
        else:
            print("settings column already exists.")
            
        print("Checking notes table...")
        cursor.execute("PRAGMA table_info(notes)")
        columns = [c[1] for c in cursor.fetchall()]
        if "is_public" not in columns:
            print("Adding is_public and public_id columns to notes table...")
            cursor.execute("ALTER TABLE notes ADD COLUMN is_public BOOLEAN DEFAULT 0")
            cursor.execute("ALTER TABLE notes ADD COLUMN public_id VARCHAR UNIQUE")
        else:
            print("is_public column already exists.")
            
        conn.commit()
        print("Migration successful.")
    except Exception as e:
        print(f"Migration failed: {e}")
        conn.rollback()
    finally:
        conn.close()

if __name__ == "__main__":
    migrate()
