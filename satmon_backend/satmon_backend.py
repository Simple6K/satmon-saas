import uvicorn

from app.server.app import create_app

app = create_app()

if __name__ == "__main__":
    uvicorn.run(
        "satmon_backend:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
