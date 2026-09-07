import sqlite3
import os
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
from sentence_transformers import SentenceTransformer

# ================= 配置区 =================
# 1. SQLite 数据库路径 (请根据实际情况修改)
SQLITE_DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'chat_memory.db')

# 2. Qdrant 配置
# 因为 Qdrant 在 Docker 里且映射了端口，宿主机访问用 localhost 即可
QDRANT_HOST = "localhost"
QDRANT_PORT = 6333
COLLECTION_NAME = "maidbot_memories"

# 3. 模型配置 (必须与 api_server.py 中使用的模型一致)
MODEL_NAME = "BAAI/bge-small-zh-v1.5"
# ==========================================

def migrate():
    print(f"🔍 正在检查数据库: {SQLITE_DB_PATH}")
    if not os.path.exists(SQLITE_DB_PATH):
        print(f"❌ 错误: 找不到数据库文件 {SQLITE_DB_PATH}")
        return

    # 1. 初始化 Qdrant 客户端
    print(f"🔌 正在连接 Qdrant ({QDRANT_HOST}:{QDRANT_PORT})...")
    client = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT)

    # 2. 加载向量化模型 (首次运行会自动下载模型，需联网)
    print(f"🧠 正在加载模型: {MODEL_NAME} ...")
    from modelscope import snapshot_download
    model_dir = snapshot_download("AI-ModelScope/bge-small-zh-v1.5", cache_dir="./models")
    model = SentenceTransformer(model_dir)

    # 3. 确保集合存在
    # 维度通常是 512 (bge-small) 或 768/1024，这里自动检测或设为 512
    collections = client.get_collections().collections
    collection_exists = any(c.name == COLLECTION_NAME for c in collections)
    
    if not collection_exists:
        print(f"🆕 创建新集合: {COLLECTION_NAME}")
        client.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=VectorParams(size=512, distance=Distance.COSINE),
        )
    else:
        print(f"✅ 集合已存在: {COLLECTION_NAME}")

    # 4. 读取 SQLite 数据
    print("📖 正在读取 SQLite 数据...")
    conn = sqlite3.connect(SQLITE_DB_PATH)
    cursor = conn.cursor()
    
    # ⚠️ 注意：这里假设你的表名是 'memories'，字段是 'content'
    # 如果你的表结构不同，请修改下面的 SQL
    try:
        cursor.execute("SELECT id, content FROM messages WHERE content IS NOT NULL")
        rows = cursor.fetchall()
    except sqlite3.OperationalError as e:
        print(f"❌ 数据库读取错误: {e}")
        print("提示: 请检查表名是否为 'memories'，或者字段名是否正确。")
        conn.close()
        return

    print(f"📦 找到 {len(rows)} 条数据待迁移...")

    # 5. 批量处理并写入 Qdrant
    points = []
    batch_size = 64 # 批量大小，避免内存溢出
    
    for i, (row_id, content) in enumerate(rows):
        if not content or len(str(content).strip()) == 0:
            continue
            
        # 生成向量
        embedding = model.encode(str(content)).tolist()
        
        # 构建点数据
        # payload 可以存储原始文本和其他元数据
        point = PointStruct(
            id=int(row_id), # 确保 ID 是整数
            vector=embedding,
            payload={"content": content}
        )
        points.append(point)

        # 每达到 batch_size 条就上传一次
        if len(points) >= batch_size:
            print(f"   🚀 正在上传批次 {i // batch_size + 1}...")
            client.upsert(collection_name=COLLECTION_NAME, points=points)
            points = []

    # 上传剩余的数据
    if points:
        print("   🚀 正在上传最后一批数据...")
        client.upsert(collection_name=COLLECTION_NAME, points=points)

    conn.close()
    print("🎉 迁移完成！")
    print(f"💡 现在你可以重启 api_server.py 并通过 /search 接口测试了。")

if __name__ == "__main__":
    migrate()
