export class FailClosed extends Error {
  constructor(message) {
    super(message);
    this.name = "FailClosed";
    this.code = "fail_closed";
  }
}

export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaError";
  }
}
