module.exports = async function handler(req, res) {
  res.status(200).json({ configured: false, test: true });
};
