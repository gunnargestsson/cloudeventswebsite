module.exports = async function (context, req) {
  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      BC_TENANT_ID: process.env.BC_TENANT_ID || null,
      BC_CLIENT_ID: process.env.BC_CLIENT_ID || null,
      BC_CLIENT_SECRET: process.env.BC_CLIENT_SECRET ? true : false,
      BC_ENVIRONMENT: process.env.BC_ENVIRONMENT || null,
    }),
  };
};
