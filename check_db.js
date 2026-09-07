const Database = require('better-sqlite3');
const fs = require('fs');

const dbs = ['chat_memory.db', 'maid_memory.db'];

dbs.forEach(dbFile => {
    if (!fs.existsSync(dbFile)) {
        console.log(`❌ ${dbFile} 不存在`);
        return;
    }
    
    console.log(`\n📂 ${dbFile}:`);
    try {
        const db = new Database(dbFile, { readonly: true });
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        
        tables.forEach(t => {
            console.log(`  📋 表: ${t.name}`);
            const schema = db.prepare(`PRAGMA table_info(${t.name})`).all();
            schema.forEach(col => {
                console.log(`     - ${col.name} (${col.type}) ${col.pk ? '🔑PK' : ''}`);
            });
            
            // 打印前2条数据预览
            const rows = db.prepare(`SELECT * FROM ${t.name} LIMIT 2`).all();
            if (rows.length > 0) {
                console.log(`     📝 数据预览:`);
                rows.forEach((row, i) => {
                    // 简单的截断显示，防止刷屏
                    const preview = JSON.stringify(row).substring(0, 150);
                    console.log(`       [${i+1}] ${preview}...`);
                });
            }
            console.log('');
        });
        db.close();
    } catch (e) {
        console.log(`   ⚠️ 读取失败: ${e.message}`);
    }
});
