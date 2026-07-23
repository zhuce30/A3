from django.test import RequestFactory, SimpleTestCase, override_settings

from backend.apps.accounts.client_ip import get_client_ip, get_trusted_country, mask_ip


@override_settings(A3_TRUSTED_PROXY_CIDRS=['127.0.0.1/32', '172.16.0.0/12'])
class ClientIpTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()

    def test_uses_forwarded_ip_only_from_trusted_proxy(self):
        trusted = self.factory.get('/', HTTP_CF_CONNECTING_IP='203.0.113.8', REMOTE_ADDR='127.0.0.1')
        self.assertEqual(get_client_ip(trusted), '203.0.113.8')

        direct = self.factory.get('/', HTTP_CF_CONNECTING_IP='203.0.113.9', REMOTE_ADDR='198.51.100.4')
        self.assertEqual(get_client_ip(direct), '198.51.100.4')

    def test_rejects_invalid_values_and_masks_ip(self):
        request = self.factory.get('/', HTTP_X_FORWARDED_FOR='not-an-ip, 203.0.113.7', REMOTE_ADDR='127.0.0.1')
        self.assertEqual(get_client_ip(request), '203.0.113.7')
        self.assertEqual(mask_ip('203.0.113.7'), '203.0.113.*')
        self.assertEqual(mask_ip('2001:db8::1'), '2001:db8::*')

    def test_country_header_requires_trusted_proxy(self):
        trusted = self.factory.get('/', HTTP_CF_IPCOUNTRY='CN', REMOTE_ADDR='127.0.0.1')
        direct = self.factory.get('/', HTTP_CF_IPCOUNTRY='US', REMOTE_ADDR='198.51.100.4')
        self.assertEqual(get_trusted_country(trusted), 'CN')
        self.assertEqual(get_trusted_country(direct), '')
