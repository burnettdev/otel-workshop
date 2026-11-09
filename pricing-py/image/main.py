import uvicorn

if __name__ == "__main__":
    # log_config=None keeps uvicorn from replacing the JSON logging set up in app.py.
    uvicorn.run("app:app", host="0.0.0.0", port=8000, log_config=None, access_log=False)
